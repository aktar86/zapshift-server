const express = require("express");
const app = express();

const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

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
    const parcelCollection = db.collection("parcels");

    //parcel API
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.sendarEmail = email;
      }

      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const result = await parcelCollection.insertOne(parcel);
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
