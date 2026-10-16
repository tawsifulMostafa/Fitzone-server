const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require("cors")
const app = express();
require("dotenv").config()
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)
app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}))
const port = process.env.NEXT_PUBLIC_SERVER_PORT || 8008;



app.use((req, res, next) => {
    if (req.originalUrl === "/api/webhook") {
        next()

    } else {
        express.json()(req, res, next)
    }
})



app.get('/', (req, res) => {
    res.send('Hello World!');
});
const client = new MongoClient(process.env.MONGODB_URI);

async function connectToMongoDB() {

    try {
        await client.connect();
        const db = client.db("FitZone");
        const sessionCollection = db.collection("session")
        const userCollection = db.collection("user")
        const classesCollection = db.collection("classes")
        const paymentCollection = db.collection("payment")
        const userFavoriteCollection = db.collection("favorite")


        const getUserId = async (req) => {
            const auth = req.headers.authorization || '';
            if (!auth.toLowerCase().startsWith("bearer "))
                return null;
            const token = auth.slice(7).trim();
            const session = await sessionCollection.findOne({
                token, expiresAt: {
                    $gt: new Date()
                },
            })
            console.log(auth)

            return session ? session.userId.toString() : null;
        }

        // PUBLIC APIS

        // only approved classes will be shown in the featured classes section

        app.get("/api/featured-classes", async (req, res) => {
            const classes = await classesCollection
                .find({ status: "approved" })
                .sort({ bookingCount: -1 })
                .limit(6)
                .toArray()
            res.send(classes)
        })

        app.get("/api/all-classes", async (req, res) => {
            const classes = await classesCollection.find({ status: "approved" }).toArray()
            res.send(classes)

        })
        app.get('/api/class/:id', async (req, res) => {
            const id = req.params.id
            const classData = await classesCollection.findOne({ _id: new ObjectId(id) })
            res.send(classData)
        })
        // payment related apis


        app.post("/api/checkout", async (req, res) => {
            try {
                const { classId } = req.body
                const userId = await getUserId(req)
                if (!userId)
                    return req.status(401).json({ error: "please sign in" })
                const cls = await classesCollection.findOne({ _id: new ObjectId(classId) })
                if (!cls) {
                    return res.status(404).json({ error: "Class not found" });
                }
                if (cls.status !== "approved") {
                    return res.status(400).json({ error: "Class is not approved for booking" });
                }
                const order = await paymentCollection.insertOne({
                    classId: cls._id,
                    className: cls.className,
                    amount: cls.price,
                    status: "pending",
                    createdAt: new Date(),
                    userId: userId
                })

                const session = await stripe.checkout.sessions.create({
                    mode: "payment",
                    line_items: [
                        {
                            price_data: {
                                currency: "usd",
                                product_data: {
                                    name: cls.className,
                                    description: `Trainer: ${cls.trainerName}`,
                                    images: cls.image ? [cls.image] : [],
                                },
                                unit_amount: Math.round(cls.price * 100),
                            },
                            quantity: 1,
                        },
                    ],
                    metadata: { orderId: order.insertedId.toString() },
                    success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.CLIENT_URL}/cancel`,
                })

                await paymentCollection.updateOne(
                    { _id: order.insertedId },
                    { $set: { stripeSessionId: session.id } }
                )

                res.send({ url: session.url })
            } catch (error) {
                console.error("Error creating checkout session:", error);
                res.status(500).json({ error: "Internal Server Error" });
            }
        })
        app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
            let event
            try {
                event = stripe.webhooks.constructEvent(
                    req.body,
                    req.headers["stripe-signature"],
                    process.env.STRIPE_WEBHOOK_SECRET
                )
            } catch (err) {
                console.error("Webhook signature error:", err.message)
                return res.status(400).send(`Webhook Error: ${err.message}`)
            }

            if (event.type === "checkout.session.completed") {
                const session = event.data.object

                if (session.payment_status === "paid") {
                    const orderId = new ObjectId(session.metadata.orderId)


                    const result = await paymentCollection.updateOne(
                        { _id: orderId, status: "pending" },
                        { $set: { status: "paid", paidAt: new Date() } }
                    )

                    if (result.modifiedCount === 1) {
                        const order = await paymentCollection.findOne({ _id: orderId })
                        await classesCollection.updateOne(
                            { _id: order.classId },
                            { $inc: { bookingCount: 1 } }
                        )
                    }
                }
            }

            res.json({ received: true })
        })

        app.get("/api/bookings/check/:classId", async (req, res) => {
            try {
                const userId = await getUserId(req)
                console.log(userId)
                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    })
                }
                const classId = new ObjectId(req.params.classId)

                const booking = await paymentCollection.findOne({
                    userId,
                    classId,
                    status: "paid"
                })
                res.json(booking)
            } catch (err) {
                console.error(err)
                res.status(500).json({ message: "Internal Server Error" })
            }
        })


        // FAVORITE APIS
        app.get("/api/favorites/:classId", async (req, res) => {
            try {
                const userId = await getUserId(req);

                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    });
                }

                const { classId } = req.params;

                if (!ObjectId.isValid(classId)) {
                    return res.status(400).json({
                        message: "Invalid Class ID"
                    });
                }

                const favorite = await userFavoriteCollection.findOne({
                    userId,
                    classId: new ObjectId(classId)
                });

                res.status(200).json(favorite);

            } catch (err) {
                console.error(err);
                res.status(500).json({
                    message: "Internal Server Error"
                });
            }
        });

        app.post("/api/favorites", async (req, res) => {
            try {
                const userId = await getUserId(req)
                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    })
                }
                const { classId } = req.body
                const cls = await classesCollection.findOne({
                    _id: new ObjectId(classId)
                })
                if (!cls) {
                    return res.status(404).json({ message: "Class Not Found" })
                }
                const result = await userFavoriteCollection.insertOne({
                    userId,
                    classId: cls._id,
                    createdAt: new Date()
                })

                res.json(result)
            } catch (err) {
                console.error(err)
                res.status(500).json({ message: "Internal Server Error" })
            }
        })
        app.delete("/api/remove/favorite/:classId", async (req, res) => {
            try {
                const userId = await getUserId(req)
                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    })
                }
                const { classId } = req.params
                if(!classId){
                    return res.json({
                        message : "class not found"
                    })
                }
                const result = await userFavoriteCollection.deleteOne({
                    userId , 
                    classId  : new ObjectId(classId)
                })
                res.json(result)
            } catch (error) {
                console.error(error)
                res.status(500).json({ message: "Internal Server Error" })
            }
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
