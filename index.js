const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-adminsdk-.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

//----------------Tracking Id
const crypto = require("crypto");

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix

  // YYYYMMDD format
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // 6-character random HEX
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

//-----------------------------------

// middleware
app.use(cors());
app.use(express.json());

//firebase token verify middleware
const verifyFireBaseToken = async (req, res, next) => {
  console.log("In the middleware:", req.headers.authorization);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorised access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decode = await admin.auth().verifyIdToken(idToken);
    console.log("decoded:", decode);
    req.decoded_email = decode.email;
    next();
  } catch (err) {
    res.status(401).send({ message: "unauthorised access" });
  }
};

const uri = `${process.env.ZS_URI}`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const run = async () => {
  try {
    await client.connect();

    const db = client.db("zap_shift_db");
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const riderCollection = db.collection("riders");

    //middle admin before allowing admin activity
    //must be used after verifyFirebase Token
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    //users related api
    app.get("/users", verifyFireBaseToken, async (req, res) => {
      const cursor = usersCollection.find().sort({ createdAt: 1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.patch(
      "/users/:id/role",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };

        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;

      const userExist = await usersCollection.findOne({ email });

      if (userExist) {
        return res.send({ message: "user exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //rider related api
    app.get("/riders", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const cursor = riderCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch(
      "/riders/:id",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const status = req.body.status;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            status: status,
          },
        };

        const result = await riderCollection.updateOne(query, updatedDoc);

        if (status === "approved") {
          const email = req.body.email;
          const userQuery = { email };
          const updateUser = {
            $set: {
              role: "rider",
            },
          };

          const userResult = await usersCollection.updateOne(
            userQuery,
            updateUser
          );
          res.send(userResult);
        }
        res.send(result);
      }
    );

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await riderCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();
      const email = rider.email;

      const riderExist = await riderCollection.findOne({ email });
      if (riderExist) {
        res.send({ message: "rider exist" });
      }

      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });

    //parcel API
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.sendarEmail = email;
      }

      const cursor = parcelCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    //----------------------------------------------
    //stripe payment api
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Please Pay for : ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],

        mode: "payment",
        customer_email: paymentInfo.sendarEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    //old
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.sendarEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      console.log(session);
      res.send({ url: session.url });
    });

    //update payment and verified api
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(" session retrive ", session);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      console.log(query);
      const paymentExists = await paymentCollection.findOne(query);
      console.log("paymentExists", paymentExists);
      if (paymentExists) {
        return res.send({
          message: "Payment already exists",
          transactionId,
          trackingId: paymentExists.trackingId,
        });
      }

      //tracking id
      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            deliveryStatus: "Paid",
            trackingId: trackingId,
          },
        };

        const result = await parcelCollection.updateOne(query, update);
        const transactionId = session.payment_intent;

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: transactionId,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);
          res.send({
            success: true,
            trackingId: trackingId,
            transactionId: transactionId,
            modifyParcel: result,
            paymentInfo: resultPayment,
          });
        }
      }
    });

    //payment related api's
    app.get("/payments", verifyFireBaseToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;

        //check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidded access" });
        }
      }

      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
};
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("zapshif server is running");
});

app.listen(port, () => {
  console.log(`zapshift server is running ${port}`);
});
