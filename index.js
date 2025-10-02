import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import fetch from "node-fetch";

const FRONTEND_URL="http://localhost:5173/"; // Update this to your frontend URL
dotenv.config();

const app = express();
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: FRONTEND_URL } });

// ------------------ MongoDB Connection ------------------
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MongoDB URI is missing. Check your .env file.");
  process.exit(1);
}
mongoose
  .connect(uri)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("MongoDB Error:", err));

// ------------------ User Schema ------------------
const userSchema = new mongoose.Schema({
  userName: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: {
    type: String,
    enum: ["Admin", "Developer", "Tester"],
    default: "Developer",
  },
});
const User = mongoose.model("User", userSchema);

// ------------------ JWT Middleware ------------------
const authMiddleware = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token missing" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

const checkRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== role)
    return res.status(403).json({ error: "Access denied" });
  next();
};

// ------------------ Auth Routes ------------------
app.post("/api/register", async (req, res) => {
  try {
    const { userName, email, password, role } = req.body;
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({ userName, email, passwordHash, role });
    await user.save();
    res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, userName: user.userName, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token, role: user.role, userName: user.userName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------ Admin Route Example ------------------
app.get("/api/admin-only", authMiddleware, checkRole("Admin"), (req, res) => {
  res.json({ message: `Hello Admin ${req.user.userName}` });
});

// ------------------ Compiler Route ------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post("/compile", async (req, res) => {
  const { language, code, stdin } = req.body;

  try {
    const submissionResponse = await fetch(
      "https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=true&wait=false&fields=*",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
          "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
        },
        body: JSON.stringify({
          source_code: Buffer.from(code).toString("base64"),
          language_id: getLanguageId(language),
          stdin: stdin ? Buffer.from(stdin).toString("base64") : null,
        }),
      }
    );

    const submission = await submissionResponse.json();
    const token = submission.token;

    if (!token) {
      return res.status(400).json({ error: submission.error || "Submission failed" });
    }

    let result;
    while (true) {
      const resultResponse = await fetch(
        `https://judge0-ce.p.rapidapi.com/submissions/${token}?base64_encoded=true&fields=*`,
        {
          headers: {
            "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
            "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
          },
        }
      );
      result = await resultResponse.json();
      if (result.status.id > 2) {
        break;
      }
      await sleep(2000);
    }

    const output = result.stdout ? Buffer.from(result.stdout, "base64").toString("utf-8") : null;
    const error = result.stderr ? Buffer.from(result.stderr, "base64").toString("utf-8") : null;

    res.json({
        output: output || error || "No output",
        status: result.status.description,
        memory: result.memory,
        time: result.time,
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getLanguageId(lang) {
  const map = { javascript: 63, python: 71, java: 62, cpp: 54, typescript: 74, c: 50 };
  return map[lang] || 63;
}

// ------------------ Room + Remark Schemas ------------------
const remarkSchema = new mongoose.Schema({
  roomId: String,
  userName: String,
  role: String,
  text: String,
  line: Number,
  createdAt: { type: Date, default: Date.now },
  resolved: { type: Boolean, default: false },
});

const roomSchema = new mongoose.Schema({
  roomId: { type: String, unique: true },
  users: [{ type: String }],
  code: { type: String, default: "" },
  language: { type: String, default: "javascript" },
});

const Remark = mongoose.model("Remark", remarkSchema);
const Room = mongoose.model("Room", roomSchema);

// ------------------ Socket.IO Logic ------------------
io.on("connection", (socket) => {
  console.log("User Connected", socket.id);

  let currentRoom = null;
  let currentUser = null;
  let currentRole = null;

  socket.on("join", async ({ roomId, userName, role }) => {
    currentRoom = roomId;
    currentUser = userName;
    currentRole = role;
    socket.join(roomId);

    let room = await Room.findOne({ roomId });
    if (!room) room = new Room({ roomId, users: [userName] });
    else if (!room.users.includes(userName)) room.users.push(userName);
    await room.save();

    io.to(roomId).emit("userJoined", room.users);
    socket.emit("codeUpdate", room.code);
    socket.emit("languageUpdate", room.language);
  });

  socket.on("languageChange", async ({ roomId, language }) => {
    if (currentRole === "Developer" || currentRole === "Admin") {
        const room = await Room.findOne({ roomId });
        if (room) {
            room.language = language;
            await room.save();
            socket.to(roomId).emit("languageUpdate", language);
        }
    }
  });

  socket.on("codeChange", async ({ roomId, code }) => {
    if (currentRole === "Developer" || currentRole === "Admin") {
      const room = await Room.findOne({ roomId });
      if (room) {
        room.code = code;
        await room.save();
        socket.to(roomId).emit("codeUpdate", code);
      }
    }
  });

  socket.on("remark:add", async ({ roomId, text, line }) => {
    if (currentRole === "Tester") {
      const remark = new Remark({ roomId, userName: currentUser, role: currentRole, text, line });
      await remark.save();
      io.to(roomId).emit("remark:update", remark);
    }
  });

  // In backend/index.js

  const handleUserExit = async () => {
    if (currentRoom && currentUser) {
      // Use an atomic $pull operation to safely remove the user
      const updatedRoom = await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { $pull: { users: currentUser } },
        { new: true } // This option returns the updated document
      );

      // If the room still exists after the update, broadcast the new user list
      if (updatedRoom) {
        io.to(currentRoom).emit("userJoined", updatedRoom.users);
      }
      
      socket.leave(currentRoom);
      currentRoom = null;
      currentUser = null;
      currentRole = null;
    }
  };

  socket.on("leaveRoom", async () => {
    await handleUserExit();
  });

  socket.on("disconnect", async () => {
    await handleUserExit();
    console.log("User Disconnected", socket.id);
  });
});

// ------------------ Start Server ------------------
const port = process.env.PORT || 10000; // Using 10000 to match Render's default

/*
// This part is now disabled because the frontend will be a separate service.
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "/frontend/dist")));
app.get(/."", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
});
*/

server.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);