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
        const applicationCollection = db.collection("application")
        const postForumCollection = db.collection("forum")
        const forumCommentCollection = db.collection("comments")


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
            console.log(session.userId.toString())

            return session ? session.userId.toString() : null;
        }
        //!  verify Role


        const verifyRole = (...roles) => {
            return async (req, res, next) => {
                const userId = await getUserId(req);

                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    });
                }

                const user = await userCollection.findOne(
                    { _id: new ObjectId(userId) },
                    {
                        projection: {
                            role: 1
                        }
                    }
                );

                if (!user || !roles.includes(user.role)) {
                    return res.status(403).json({
                        message: "Forbidden"
                    });
                }

                req.userId = userId;
                next();
            };
        };

        // * PUBLIC APIS

        // * only approved classes will be shown in the featured classes section

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
        app.get("/api/class/:classId", async (req, res) => {
            const { classId } = req.params;
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }
            const data = await classesCollection.findOne({
                _id: new ObjectId(classId)
            })
            const user = await userCollection.findOne({
                _id: new ObjectId(data.trainerId)
            })
            const currentUser = await userCollection.findOne({
                _id: new ObjectId(userId)
            })
            const classData = {
                ...data,
                trainerName: user?.name
            }
            if (classData.status === "approved") {
                return res.json(classData);
            }
            if (
                currentUser?.role === "trainer" &&
                classData.trainerId === userId

            ) {
                return res.json(classData);
            }

            // Admin can review non-approved classes
            if (currentUser?.role === "admin") {
                return res.json(classData);
            }
            return res.status(403).json({
                message: "Forbidden"
            });
        })





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
                                    name: cls.name,
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
        //member apis
        //member overview


        // app.get("/api/dashboard/overview:userId" , async(req , res)=>{
        //     const userId = await getUserId(req)
        //     if(!userId){
        //         return res.json({message : "unauthorized"})
        //     }
        //     const totalBookings = await paymentCollection.find({
        //         userId , 
        //         status : "paid"
        //     }).toArray()
        //     const bookings = []
        //     for(const totalBooking of totalBookings){
        //         const classData = await classesCollection.findOne({
        //             _id : new ObjectId(totalBooking.classId)
        //         });
        //         bookings.push({
        //             ...totalBooking ,
        //             classData
        //         })
        //     }
        //     res.json(bookings)
        // })


        app.get("/api/member/bookings", async (req, res) => {
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }
            const payments = await paymentCollection.find({
                userId: userId,
                status: "paid",

            }).toArray()
            const bookings = [];
            for (const payment of payments) {
                const classData = await classesCollection.findOne({
                    _id: new ObjectId(payment.classId)
                });

                bookings.push({
                    ...payment,
                    classData
                })

            }
            res.json(bookings)


        })
        // apply as a trainer // api for member
        await applicationCollection.createIndex(
            { userId: 1 },
            { unique: true }
        );
        app.post("/api/apply/trainer", async (req, res) => {
            try {
                const application = req.body
                const userId = await getUserId(req)
                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    });
                }
                const newApplication = {
                    ...application,
                    userId,
                    status: "pending",
                    createdAt: new Date()
                }

                const result = await applicationCollection.insertOne(newApplication);

                res.json(result)
            } catch (error) {
                res.status(409).json({ message: "already exists" })
            }

        })

        app.get("/api/apply/trainer", async (req, res) => {
            const userId = await getUserId(req)
            if (!userId) {
                res.status(401).json({
                    message: "unauthorized"
                })
            }

            const result = await applicationCollection.findOne({
                userId,
                status: "pending"
            })
            res.json(result)
        })


        // FAVORITE APIS

        app.get("/api/dashboard/favorites/:classId", async (req, res) => {
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                });
            }
            const favoritesBookings = await userFavoriteCollection.find({
                userId
            }).toArray()
            const favorites = [];

            for (const favoriteBooking of favoritesBookings) {
                const classData = await classesCollection.findOne({
                    _id: new ObjectId(favoriteBooking.classId)
                })

                favorites.push({
                    ...favoriteBooking,
                    classData
                })
            }
            res.json(favorites)
        })



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

        await userFavoriteCollection.createIndex(
            { userId: 1, classId: 1 },
            { unique: true }
        );


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
                if (err.code === 11000) {
                    return res.status(409).json({
                        message: "Already in favorites"
                    });
                }

                console.error(err);
                res.status(500).json({
                    message: "Internal Server Error"
                });
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
                const { classId } = req.body
                if (!classId) {
                    return res.json({
                        message: "class not found"
                    })
                }
                const result = await userFavoriteCollection.deleteOne({
                    userId,
                    classId: new ObjectId(classId)
                })
                res.json(result)
            } catch (error) {
                console.error(error)
                res.status(500).json({ message: "Internal Server Error" })
            }
        })

        // TRAINER APIS
        //* get Forum post 
        app.get("/api/get/forum", async (req, res) => {
            const result = await postForumCollection.find({}).toArray()
            res.json(result)
        })

        // forum details

        app.get("/api/forum/:id", async (req, res) => {
            const { id } = req.params
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }
            const forums = await postForumCollection.findOne({
                _id: new ObjectId(id)
            })
            if (!forums) {
                return res.status(404).json({
                    message: "forum post not available"
                })
            }
            const poster = await userCollection.findOne({
                _id: new ObjectId(forums.posterId)
            })
            const userLiked = forums.likes?.includes(userId) || false;
            const userDisliked = forums.dislikes?.includes(userId) || false;
            const { likes, dislikes, ...forumData } = forums
            const forum = {
                ...forumData,
                poster,
                likeCount: likes?.length || 0,
                dislikeCount: dislikes?.length || 0,
                userLiked,
                userDisliked
            };

            res.json(forum)
        })
        // * edit comments
        app.patch("/api/post/forum/comment/edit/:commentId", async (req, res) => {
            const { commentId } = req.params
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }

            const { updatedComment } = req.body
            const result = await forumCommentCollection.updateOne({
                commentedBy: userId,
                _id: new ObjectId(commentId)
            },{
                $set: {
                    Comment: updatedComment
                }
            });
            if (!result.matchedCount) {
                return res.status(404).json({
                    message: "Comment not found or unauthorized"
                });
            }

            res.json({
                message: "Comment updated successfully"
            });
        });

        // * get Comment 
        app.get("/api/post/forum/comment/:forumId", async (req, res) => {
            const { forumId } = req.params
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }
            const comments = await forumCommentCollection.find({
                forumId
            }).toArray()
            const result = []
            for (const comment of comments) {
                const user = await userCollection.findOne({
                    _id: new ObjectId(comment.commentedBy)
                })
                result.push({
                    ...comment,
                    userName: user.name,
                    userImage: user.image,
                    commentId: comment._id
                })
            }
            res.json(result)

        })
        // * Comment for forum 

        app.post("/api/post/forum/comment/:forumId", async (req, res) => {
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "authorized"
                })
            }
            const { forumId } = req.params;
            const { newComment } = req.body;
            const forum = await forumCommentCollection.insertOne({
                ...newComment,
                commentedBy: userId,
                forumId,
                parentCommentId: newComment.parentCommentId
                    ? new ObjectId(newComment.parentCommentId)
                    : null,
                createdAt: new Date(),
            })
            res.json(forum)
        })

        // * forum like dislike control

        app.post("/api/post/forum/reaction/:forumId", async (req, res) => {
            const { forumId } = req.params;
            console.log("forumId", forumId);
            console.log("forumId:", req.params.forumId);
            console.log("isValid:", ObjectId.isValid(req.params.forumId));
            if (!ObjectId.isValid(forumId)) {
                return res.status(400).json({
                    message: "Invalid forum ID"
                });
            }
            console.log(forumId);
            const { reaction } = req.body
            const userId = await getUserId(req)
            if (!userId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }
            const post = await postForumCollection.findOne({
                _id: new ObjectId(forumId)
            })
            console.log(post);
            if (!post) {
                return res.status(404).json({
                    message: "post not found"
                })
            }
            const currentReaction = reaction === "like" ? "likes" : "dislikes";
            const oppositeReaction = reaction === "like" ? "dislikes" : "likes";

            if (!["like", "dislike"].includes(reaction)) {
                return res.status(400).json({
                    message: "Invalid reaction"
                });
            };

            if (post[currentReaction].includes(userId)) {
                await postForumCollection.updateOne({
                    _id: new ObjectId(forumId)
                },
                    {
                        $pull: {
                            [currentReaction]: userId
                        }
                    })
            } else {
                await postForumCollection.updateOne(
                    {
                        _id: new ObjectId(forumId)
                    },
                    {
                        $addToSet: {
                            [currentReaction]: userId
                        },
                        $pull: {
                            [oppositeReaction]: userId
                        }
                    }
                );

            }
            return res.status(200).json({
                message: "reaction updated"
            })
        });

        // * add forum post

        app.post("/api/forum/post", verifyRole("trainer", "admin"), async (req, res) => {
            const userId = req.userId;
            console.log(userId)
            const forumData = req.body
            const user = await userCollection.findOne({
                _id: new ObjectId(userId)
            })
            console.log(user);
            const result = await postForumCollection.insertOne({
                ...forumData,
                posterId: userId,
                likes: [],
                dislikes: []
            })
            await postForumCollection.updateMany(
                { likes: { $exists: false } },
                { $set: { likes: [] } }
            );

            await postForumCollection.updateMany(
                { dislikes: { $exists: false } },
                { $set: { dislikes: [] } }
            );
            res.json(result)
        })

        app.get("/api/my/class", verifyRole("trainer"), async (req, res) => {
            const trainerId = req.userId;
            if (!trainerId) {
                return res.status(401).json({
                    message: "unauthorized"
                })
            }

            const result = await classesCollection.find({
                trainerId,
            }).toArray();
            if (result.length === 0) {
                return res.status(404).json([]);
            }
            return res.json(result);
        });
        app.post("/api/create/class", verifyRole("trainer"), async (req, res) => {
            try {
                const classData = req.body
                const userId = req.userId
                if (!userId) {
                    return res.status(401).json({
                        message: "unauthorized"
                    })
                }
                const data = {
                    ...classData,
                    trainerId: userId,
                    status: "pending",
                    bookingCount: 0,
                    createdAt: new Date()
                }
                const result = await classesCollection.insertOne(data)
                res.json(result)
            } catch (error) {
                console.log(error.message);

                return res.status(500).json({
                    message: "Failed to create class"
                });
            }
        })
        // ** Edit Class
        app.patch("/api/edit/class/:id", verifyRole("trainer"), async (req, res) => {
            const userId = req.userId;
            const { id } = req.params;
            const cls = await classesCollection.findOne({
                _id: new ObjectId(id)
            });

            if (!cls) {
                return res.status(404).json({
                    message: "Class not found"
                });
            }

            if (cls.trainerId !== userId) {
                return res.status(403).json({
                    message: "forbidden"
                });
            }

            const classData = await classesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: req.body }
            );

            res.json(classData);
        });
        //! Delete class
        app.delete("/api/class/delete/:id", verifyRole("trainer"), async (req, res) => {
            const userId = req.userId
            const { id } = req.params
            const cls = await classesCollection.findOne({
                _id: new ObjectId(id)
            })
            if (!cls) {
                return res.status(404).json({
                    message: "Class not found"
                });
            }

            if (cls.trainerId !== userId) {
                return res.status(403).json({
                    message: "forbidden"
                });
            }
            const classData = await classesCollection.deleteOne({
                _id: new ObjectId(id)
            })
            res.json(classData)
        })

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
