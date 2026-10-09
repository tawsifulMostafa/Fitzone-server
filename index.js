const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require("cors")
const app = express();
require("dotenv").config()
app.use(cors())
app.use(express.json());
const port = process.env.NEXT_PUBLIC_SERVER_PORT || 8008;




app.get('/', (req, res) => {
    res.send('Hello World!');
});
const client = new MongoClient(process.env.MONGODB_URI);

async function connectToMongoDB() {
    try {
        await client.connect();
        const db = client.db("FitZone");
        const classesCollection = db.collection("classes")

        // PUBLIC APIS
        app.get("/api/featured-classes", async (req, res) => {
            const featuredClasses = await classesCollection.find().sort({ bookingCount: -1 }).limit(6).toArray()
            res.send(featuredClasses)
            console.log(featuredClasses);

        })

        app.get("/api/classes", async (req, res) => {
            const classes = await classesCollection.find().toArray()
            res.send(classes)
        })
        // TRAINING APIS




        // ADMIN APIS



        console.log("You successfully connected to MongoDB");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

connectToMongoDB()
app.listen(port, () => {
    console.log("PORT:", port);
    console.log("HOST:", require("os").hostname());
    console.log(`Example app listening on port ${port}`);
});
