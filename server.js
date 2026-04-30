const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "25mb" }));

app.get("/", (req, res) => {
  res.send("Live Translate WebRTC Server is running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let waitingUser = null;
const userRooms = new Map();

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("find-match", () => {
    if (waitingUser && waitingUser !== socket.id) {
      const roomId = `room-${waitingUser}-${socket.id}`;
      const waitingSocket = io.sockets.sockets.get(waitingUser);

      if (!waitingSocket) {
        waitingUser = socket.id;
        socket.emit("waiting");
        return;
      }

      socket.join(roomId);
      waitingSocket.join(roomId);

      userRooms.set(socket.id, roomId);
      userRooms.set(waitingUser, roomId);

      waitingSocket.emit("matched", {
        roomId,
        initiator: true,
        peerId: socket.id
      });

      socket.emit("matched", {
        roomId,
        initiator: false,
        peerId: waitingUser
      });

      waitingUser = null;
    } else {
      waitingUser = socket.id;
      socket.emit("waiting");
    }
  });

  socket.on("offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  socket.on("chat-message", ({ roomId, message }) => {
    socket.to(roomId).emit("chat-message", { message });
  });

  socket.on("translate-message", async ({ roomId, text, targetLanguage }) => {
    try {
      if (!roomId || !text) return;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a live video chat translation engine. Translate the user's message naturally. Return only the translated text. No explanations."
          },
          {
            role: "user",
            content: `Translate this message to ${targetLanguage || "English"}:\n\n${text}`
          }
        ]
      });

      const translated =
        completion.choices?.[0]?.message?.content?.trim() || "";

      io.to(roomId).emit("translation-result", {
        original: text,
        translated,
        targetLanguage: targetLanguage || "English"
      });
    } catch (error) {
      console.error("Translation error:", error);

      socket.emit("translation-error", {
        message: "Translation failed"
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    if (waitingUser === socket.id) {
      waitingUser = null;
    }

    const roomId = userRooms.get(socket.id);

    if (roomId) {
      socket.to(roomId).emit("partner-left");
      userRooms.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
