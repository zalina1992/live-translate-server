const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "20mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Voxlify server",
    online: io.engine.clientsCount || 0
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 20 * 1024 * 1024,
  pingTimeout: 30000,
  pingInterval: 15000
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 1,
  timeout: 45000
});

let waitingUser = null;
const userRooms = new Map();
const busySockets = new Set();

function emitOnlineCount() {
  io.emit("online-count", {
    count: io.engine.clientsCount || 0
  });
}

function cleanupSocket(socket) {
  if (waitingUser === socket.id) waitingUser = null;

  const roomId = userRooms.get(socket.id);

  if (roomId) {
    socket.to(roomId).emit("partner-left");

    const clients = io.sockets.adapter.rooms.get(roomId);
    if (clients) {
      for (const id of clients) {
        userRooms.delete(id);
      }
    }
  }

  userRooms.delete(socket.id);
  busySockets.delete(socket.id);
}

async function transcribeAudio(audioBuffer) {
  const audioFile = await toFile(audioBuffer, "speech.webm", {
    type: "audio/webm"
  });

  return openai.audio.transcriptions.create({
    file: audioFile,
    model: "whisper-1"
  });
}

async function translateText(text, targetLanguage = "English") {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Detect the source language and translate naturally. Return only translated text. No explanations."
      },
      {
        role: "user",
        content: `Translate to ${targetLanguage}:\n\n${text}`
      }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);
  emitOnlineCount();

  socket.on("get-online-count", emitOnlineCount);

  socket.on("find-match", () => {
    cleanupSocket(socket);

    if (waitingUser && waitingUser !== socket.id) {
      const partnerSocket = io.sockets.sockets.get(waitingUser);

      if (!partnerSocket) {
        waitingUser = socket.id;
        socket.emit("waiting");
        return;
      }

      const roomId = `room-${waitingUser}-${socket.id}`;

      socket.join(roomId);
      partnerSocket.join(roomId);

      userRooms.set(socket.id, roomId);
      userRooms.set(waitingUser, roomId);

      partnerSocket.emit("matched", {
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

    emitOnlineCount();
  });

  socket.on("leave-room", ({ roomId }) => {
    if (roomId) {
      socket.to(roomId).emit("partner-left");
      socket.leave(roomId);
    }

    cleanupSocket(socket);
    emitOnlineCount();
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

  socket.on("audio-chunk", async ({ roomId, audioBase64, targetLanguage }) => {
    try {
      if (!roomId || !audioBase64) return;

      if (busySockets.has(socket.id)) return;
      busySockets.add(socket.id);

      const base64Data = audioBase64.split(",")[1];
      if (!base64Data) return;

      const audioBuffer = Buffer.from(base64Data, "base64");

      if (audioBuffer.length < 18000 || audioBuffer.length > 260000) return;

      console.log("Audio:", audioBuffer.length, socket.id);

      const transcription = await transcribeAudio(audioBuffer);
      const original = transcription.text?.trim();

      if (!original || original.length < 3) return;

      const translated = await translateText(
        original,
        targetLanguage || "English"
      );

      io.to(roomId).emit("translation-result", {
        original,
        translated,
        targetLanguage: targetLanguage || "English"
      });
    } catch (error) {
      const message = error?.message || "Audio translation failed";
      const code = error?.code || error?.error?.code;

      console.error("Audio translation error:", { message, code });

      socket.emit("translation-error", {
        message:
          code === "insufficient_quota"
            ? "AI quota exceeded. Add billing or increase limits."
            : "AI translation temporarily unavailable.",
        code
      });
    } finally {
      busySockets.delete(socket.id);
    }
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    cleanupSocket(socket);
    emitOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voxlify server running on port ${PORT}`);
});
