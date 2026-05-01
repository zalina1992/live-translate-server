const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 15000
});

const waitingUsers = [];
const userRooms = new Map();
const busySockets = new Set();
const profiles = new Map();
const translationCache = new Map();

const languageMap = {
  English: "en",
  Polish: "pl",
  Norwegian: "no",
  Spanish: "es",
  German: "de",
  French: "fr",
  Italian: "it",
  Portuguese: "pt",
  Japanese: "ja",
  Korean: "ko",
  Arabic: "ar"
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Voxlify server",
    online: io.engine.clientsCount || 0
  });
});

function emitOnlineCount() {
  io.emit("online-count", {
    count: io.engine.clientsCount || 0
  });
}

function removeFromWaiting(socketId) {
  const index = waitingUsers.indexOf(socketId);
  if (index !== -1) waitingUsers.splice(index, 1);
}

function getPartnerId(roomId, socketId) {
  const clients = io.sockets.adapter.rooms.get(roomId);
  if (!clients) return null;

  for (const id of clients) {
    if (id !== socketId) return id;
  }

  return null;
}

function cleanupSocket(socket) {
  removeFromWaiting(socket.id);

  const roomId = userRooms.get(socket.id);

  if (roomId) {
    socket.to(roomId).emit("partner-left");

    const clients = io.sockets.adapter.rooms.get(roomId);
    if (clients) {
      for (const id of clients) {
        userRooms.delete(id);
      }
    }

    socket.leave(roomId);
  }

  userRooms.delete(socket.id);
  busySockets.delete(socket.id);
}

async function translateText(text, targetLanguage = "Polish") {
  const target = languageMap[targetLanguage] || "pl";
  const clean = String(text || "").trim().slice(0, 500);

  if (!clean) return "";

  const cacheKey = `${target}:${clean.toLowerCase()}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const endpoints = [
    "https://translate.argosopentech.com/translate",
    "https://libretranslate.de/translate"
  ];

  let lastError;

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: clean,
          source: "auto",
          target,
          format: "text"
        })
      });

      if (!response.ok) {
        throw new Error(`Translate HTTP ${response.status}`);
      }

      const data = await response.json();
      const translated = data.translatedText || clean;

      translationCache.set(cacheKey, translated);

      if (translationCache.size > 1000) {
        const firstKey = translationCache.keys().next().value;
        translationCache.delete(firstKey);
      }

      return translated;
    } catch (error) {
      lastError = error;
    }
  }

  console.error("Translate failed:", lastError?.message || lastError);
  return clean;
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  profiles.set(socket.id, {
    country: null,
    gender: "any",
    targetLanguage: "Polish"
  });

  emitOnlineCount();

  socket.on("get-online-count", emitOnlineCount);

  socket.on("update-preferences", data => {
    const old = profiles.get(socket.id) || {};

    profiles.set(socket.id, {
      ...old,
      country: data?.country || old.country || null,
      gender: data?.gender || old.gender || "any",
      targetLanguage: data?.targetLanguage || old.targetLanguage || "Polish"
    });
  });

  socket.on("find-match", data => {
    cleanupSocket(socket);

    profiles.set(socket.id, {
      country: data?.country || null,
      gender: data?.gender || "any",
      targetLanguage: data?.targetLanguage || "Polish"
    });

    let partnerId = null;

    while (waitingUsers.length > 0 && !partnerId) {
      const candidateId = waitingUsers.shift();

      if (candidateId === socket.id) continue;

      const candidateSocket = io.sockets.sockets.get(candidateId);

      if (candidateSocket && !userRooms.has(candidateId)) {
        partnerId = candidateId;
      }
    }

    if (!partnerId) {
      waitingUsers.push(socket.id);
      socket.emit("waiting");
      emitOnlineCount();
      return;
    }

    const partnerSocket = io.sockets.sockets.get(partnerId);

    if (!partnerSocket) {
      waitingUsers.push(socket.id);
      socket.emit("waiting");
      emitOnlineCount();
      return;
    }

    const roomId = `room-${partnerId}-${socket.id}`;

    socket.join(roomId);
    partnerSocket.join(roomId);

    userRooms.set(socket.id, roomId);
    userRooms.set(partnerId, roomId);

    partnerSocket.emit("matched", {
      roomId,
      initiator: true,
      peerId: socket.id
    });

    socket.emit("matched", {
      roomId,
      initiator: false,
      peerId: partnerId
    });

    emitOnlineCount();
  });

  socket.on("leave-room", ({ roomId }) => {
    if (roomId) {
      socket.to(roomId).emit("partner-left");
    }

    cleanupSocket(socket);
    emitOnlineCount();
  });

  socket.on("offer", ({ roomId, offer }) => {
    if (!roomId || !offer) return;
    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", ({ roomId, answer }) => {
    if (!roomId || !answer) return;
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    if (!roomId || !candidate) return;
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  socket.on("speech-interim", ({ roomId, text }) => {
    if (!roomId || !text) return;

    socket.to(roomId).emit("peer-typing", {
      text: String(text).slice(0, 500)
    });
  });

  socket.on("speech-final", async ({ roomId, text }) => {
    try {
      if (!roomId || !text) return;
      if (busySockets.has(socket.id)) return;

      busySockets.add(socket.id);

      const cleanText = String(text).trim().slice(0, 500);
      if (!cleanText) return;

      const partnerId = getPartnerId(roomId, socket.id);
      const partnerProfile = profiles.get(partnerId) || {};
      const targetLanguage = partnerProfile.targetLanguage || "Polish";

      const translated = await translateText(cleanText, targetLanguage);

      socket.to(roomId).emit("translation-result", {
        original: cleanText,
        translated,
        targetLanguage
      });
    } catch (error) {
      console.error("Translation error:", error.message);

      socket.to(roomId).emit("translation-error", {
        message: "Translation temporarily unavailable."
      });
    } finally {
      busySockets.delete(socket.id);
    }
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    cleanupSocket(socket);
    profiles.delete(socket.id);

    emitOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voxlify server running on port ${PORT}`);
});
