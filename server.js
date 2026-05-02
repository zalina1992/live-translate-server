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
const profiles = new Map();
const busySockets = new Set();
const translationCache = new Map();

const languageMap = {
  Afrikaans: "af", Albanian: "sq", Amharic: "am", Arabic: "ar", Armenian: "hy",
  Azerbaijani: "az", Basque: "eu", Belarusian: "be", Bengali: "bn", Bosnian: "bs",
  Bulgarian: "bg", Catalan: "ca", Cebuano: "ceb", Chinese: "zh", Croatian: "hr",
  Czech: "cs", Danish: "da", Dutch: "nl", English: "en", Esperanto: "eo",
  Estonian: "et", Finnish: "fi", French: "fr", Galician: "gl", Georgian: "ka",
  German: "de", Greek: "el", Gujarati: "gu", Haitian: "ht", Hausa: "ha",
  Hebrew: "iw", Hindi: "hi", Hungarian: "hu", Icelandic: "is", Igbo: "ig",
  Indonesian: "id", Irish: "ga", Italian: "it", Japanese: "ja", Javanese: "jw",
  Kannada: "kn", Kazakh: "kk", Khmer: "km", Korean: "ko", Kurdish: "ku",
  Kyrgyz: "ky", Lao: "lo", Latin: "la", Latvian: "lv", Lithuanian: "lt",
  Luxembourgish: "lb", Macedonian: "mk", Malagasy: "mg", Malay: "ms", Malayalam: "ml",
  Maltese: "mt", Maori: "mi", Marathi: "mr", Mongolian: "mn", Nepali: "ne",
  Norwegian: "no", Pashto: "ps", Persian: "fa", Polish: "pl", Portuguese: "pt",
  Punjabi: "pa", Romanian: "ro", Russian: "ru", Serbian: "sr", Slovak: "sk",
  Slovenian: "sl", Somali: "so", Spanish: "es", Sundanese: "su", Swahili: "sw",
  Swedish: "sv", Tamil: "ta", Telugu: "te", Thai: "th", Turkish: "tr",
  Ukrainian: "uk", Urdu: "ur", Uzbek: "uz", Vietnamese: "vi", Welsh: "cy",
  Xhosa: "xh", Yiddish: "yi", Yoruba: "yo", Zulu: "zu"
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Voxlify server",
    online: io.of("/").sockets.size
  });
});

function emitOnlineCount() {
  io.emit("online-count", {
    count: io.of("/").sockets.size
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
    const clients = io.sockets.adapter.rooms.get(roomId);

    if (clients) {
      for (const id of clients) {
        userRooms.delete(id);

        const s = io.sockets.sockets.get(id);
        if (s) {
          s.leave(roomId);
        }

        if (id !== socket.id) {
          io.to(id).emit("partner-left");
        }
      }
    }
  }

  userRooms.delete(socket.id);
  busySockets.delete(socket.id);
}

async function translateText(text, targetLanguage = "English") {
  const target = languageMap[targetLanguage] || "en";
  const clean = String(text || "").trim().slice(0, 700);

  if (!clean) return "";

  const cacheKey = `${target}:${clean.toLowerCase()}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx" +
      "&sl=auto" +
      `&tl=${encodeURIComponent(target)}` +
      "&dt=t" +
      `&q=${encodeURIComponent(clean)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) throw new Error(`Translate HTTP ${response.status}`);

    const data = await response.json();

    const translated = Array.isArray(data?.[0])
      ? data[0].map(part => part[0]).join("")
      : clean;

    translationCache.set(cacheKey, translated || clean);

    if (translationCache.size > 3000) {
      const firstKey = translationCache.keys().next().value;
      translationCache.delete(firstKey);
    }

    return translated || clean;
  } catch (error) {
    console.error("Translate failed:", error.message);
    return clean;
  }
}
const warnings = new Map();
const bannedSockets = new Set();

const badWords = [
  "bitch",
  "slut",
  "whore",
  "porn",
  "sex",
  "nigger",
  "rape"
  "retard"
];

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsBadWord(text) {
  const clean = normalizeText(text);

  return badWords.some(word => {
    const pattern = new RegExp(`\\b${word}\\b`, "i");
    return pattern.test(clean);
  });
}

function handleModeration(socket, text) {
  if (bannedSockets.has(socket.id)) {
    socket.emit("moderation-banned");
    return { banned: true };
  }

  if (!containsBadWord(text)) {
    return { ok: true };
  }

  const count = (warnings.get(socket.id) || 0) + 1;
  warnings.set(socket.id, count);

  if (count >= 2) {
    bannedSockets.add(socket.id);
    socket.emit("moderation-banned");
    cleanupSocket(socket);
    return { banned: true };
  }

  socket.emit("moderation-warning", {
    count,
    message: "Warning: inappropriate language is not allowed. Next violation will disconnect you."
  });

  return { warning: true };
}
io.on("connection", socket => {
  console.log("Connected:", socket.id);

  profiles.set(socket.id, {
    country: null,
    gender: "any",
    speakLanguage: "English"
  });

  emitOnlineCount();

  socket.on("get-online-count", emitOnlineCount);

  socket.on("update-preferences", data => {
    const old = profiles.get(socket.id) || {};

    profiles.set(socket.id, {
      ...old,
      country: data?.country || old.country || null,
      gender: data?.gender || old.gender || "any",
      speakLanguage: data?.speakLanguage || old.speakLanguage || "English"
    });
  });

  socket.on("find-match", data => {
  if (userRooms.has(socket.id)) return;

  removeFromWaiting(socket.id);

  console.log("find-match:", socket.id, "waiting:", waitingUsers.length, "online:", io.of("/").sockets.size);

  profiles.set(socket.id, {
    country: data?.country || null,
    gender: data?.gender || "any",
    speakLanguage: data?.speakLanguage || "English"
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
    if (!waitingUsers.includes(socket.id)) {
      waitingUsers.push(socket.id);
    }

    socket.emit("waiting");
    emitOnlineCount();
    return;
  }

  const partnerSocket = io.sockets.sockets.get(partnerId);

  if (!partnerSocket) {
    if (!waitingUsers.includes(socket.id)) {
      waitingUsers.push(socket.id);
    }

    socket.emit("waiting");
    emitOnlineCount();
    return;
  }

  const roomId = `room-${Date.now()}-${partnerId}-${socket.id}`;

  socket.join(roomId);
  partnerSocket.join(roomId);

  userRooms.set(socket.id, roomId);
  userRooms.set(partnerId, roomId);

  const myProfile = profiles.get(socket.id) || {};
  const partnerProfile = profiles.get(partnerId) || {};

  partnerSocket.emit("matched", {
    roomId,
    initiator: true,
    peerId: socket.id,
    peerProfile: myProfile
  });

  socket.emit("matched", {
    roomId,
    initiator: false,
    peerId: partnerId,
    peerProfile: partnerProfile
  });

  emitOnlineCount();
});

socket.on("leave-room", data => {
  const roomId = userRooms.get(socket.id);

  removeFromWaiting(socket.id);

  if (!roomId) {
    emitOnlineCount();
    return;
  }

  const partnerId = getPartnerId(roomId, socket.id);

  socket.leave(roomId);
  userRooms.delete(socket.id);
  busySockets.delete(socket.id);

  if (partnerId) {
    const partnerSocket = io.sockets.sockets.get(partnerId);

    userRooms.delete(partnerId);

    if (partnerSocket) {
      partnerSocket.leave(roomId);
      partnerSocket.emit("partner-left", {
        manualStop: data?.manualStop === true
      });
    }
  }

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
      text: String(text).trim().slice(0, 500)
    });
  });

  socket.on("speech-final", async ({ roomId, text }) => {
    try {
      if (!roomId || !text) return;
      if (busySockets.has(socket.id)) return;

      const cleanText = String(text).trim().slice(0, 700);
      if (!cleanText) return;

      const partnerId = getPartnerId(roomId, socket.id);
      if (!partnerId) return;

      const partnerProfile = profiles.get(partnerId) || {};
      const targetLanguage = partnerProfile.speakLanguage || "English";

      busySockets.add(socket.id);

      const translated = await translateText(cleanText, targetLanguage);

      io.to(partnerId).emit("translation-result", {
        original: cleanText,
        translated,
        targetLanguage
      });
    } catch (error) {
      console.error("Translation error:", error.message);
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
