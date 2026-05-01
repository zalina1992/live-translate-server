const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.send("Live Translate WebRTC Server is running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 50 * 1024 * 1024
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 0,
  timeout: 90000
});

let waitingUser = null;
const userRooms = new Map();
const socketBusy = new Map();

function emitOnlineCount() {
  io.emit("online-count", {
    count: io.engine.clientsCount || 0
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeAudio(audioFile) {
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1"
      });
    } catch (error) {
      lastError = error;

      console.log(
        `Transcription retry ${attempt}:`,
        error?.message || error?.cause?.code || error
      );

      await sleep(2500 * attempt);
    }
  }

  throw lastError;
}

async function translateText(text, targetLanguage = "English") {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a live video chat translation engine. Detect the source language and translate naturally. Return only the translated text. No explanations."
          },
          {
            role: "user",
            content: `Translate this to ${targetLanguage}:\n\n${text}`
          }
        ]
      });

      return completion.choices?.[0]?.message?.content?.trim() || "";
    } catch (error) {
      lastError = error;
      console.log(`Translation retry ${attempt}:`, error?.message || error);
      await sleep(1800 * attempt);
    }
  }

  throw lastError;
}

app.get("/openai-test", async (req, res) => {
  try {
    const translated = await translateText("Cześć, jak się masz?", "English");

    res.json({
      ok: true,
      translated
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error?.message || "OpenAI test failed",
      code: error?.cause?.code || error?.code || null
    });
  }
});

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  emitOnlineCount();

  socket.on("find-match", ({ country, gender } = {}) => {
    socket.data.country = country || null;
    socket.data.gender = gender || "any";

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
        peerId: socket.id,
        peerCountry: socket.data.country,
        peerGender: socket.data.gender
      });

      socket.emit("matched", {
        roomId,
        initiator: false,
        peerId: waitingUser,
        peerCountry: waitingSocket.data.country,
        peerGender: waitingSocket.data.gender
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

      const translated = await translateText(text, targetLanguage || "English");

      io.to(roomId).emit("translation-result", {
        original: text,
        translated,
        targetLanguage: targetLanguage || "English"
      });
    } catch (error) {
      console.error("Translation error:", error?.message || error);

      socket.emit("translation-error", {
        message: "Translation failed"
      });
    }
  });

  socket.on("audio-chunk", async ({ roomId, audioBase64, targetLanguage }) => {
    try {
      if (!roomId || !audioBase64) return;

      if (socketBusy.get(socket.id)) {
        return;
      }

      socketBusy.set(socket.id, true);

      const base64Data = audioBase64.split(",")[1];
      if (!base64Data) {
        socketBusy.set(socket.id, false);
        return;
      }

      const audioBuffer = Buffer.from(base64Data, "base64");

      if (!audioBuffer || audioBuffer.length < 3000) {
        socketBusy.set(socket.id, false);
        return;
      }

      console.log("Audio size:", audioBuffer.length);

      const audioFile = await toFile(audioBuffer, "speech.webm", {
        type: "audio/webm"
      });

      const transcription = await transcribeAudio(audioFile);
      const original = transcription.text?.trim();

      console.log("TRANSCRIPTION:", original);

      if (!original || original.length < 2) {
        socketBusy.set(socket.id, false);
        return;
      }

      const translated = await translateText(
        original,
        targetLanguage || "English"
      );

      io.to(roomId).emit("translation-result", {
        original,
        translated,
        targetLanguage: targetLanguage || "English"
      });

      socketBusy.set(socket.id, false);
    } catch (error) {
      socketBusy.set(socket.id, false);

      console.error("Audio translation error:", {
        message: error?.message,
        code: error?.code || error?.cause?.code,
        cause: error?.cause?.message || error?.cause
      });

      socket.emit("translation-error", {
        message: "Audio translation failed"
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    socketBusy.delete(socket.id);

    if (waitingUser === socket.id) {
      waitingUser = null;
    }

    const roomId = userRooms.get(socket.id);

    if (roomId) {
      socket.to(roomId).emit("partner-left");
      userRooms.delete(socket.id);
    }

    setTimeout(emitOnlineCount, 100);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
