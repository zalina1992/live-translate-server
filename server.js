const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "8mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 15000,
  maxHttpBufferSize: 8e6
});

const waitingUsers = [];
const userRooms = new Map();
const profiles = new Map();
const busySockets = new Set();
const translationCache = new Map();

const warnings = new Map();
const reports = new Map();
const bannedIPs = new Set();
const bannedFingerprints = new Set();
const lastReport = new Map();

const languageMap = {
  Afrikaans: "af", Albanian: "sq", Arabic: "ar", Armenian: "hy",
  Azerbaijani: "az", Basque: "eu", Bengali: "bn", Bosnian: "bs",
  Bulgarian: "bg", Catalan: "ca", Chinese: "zh", Croatian: "hr",
  Czech: "cs", Danish: "da", Dutch: "nl", English: "en",
  Estonian: "et", Finnish: "fi", French: "fr", Georgian: "ka",
  German: "de", Greek: "el", Gujarati: "gu", Hebrew: "iw",
  Hindi: "hi", Hungarian: "hu", Icelandic: "is", Indonesian: "id",
  Irish: "ga", Italian: "it", Japanese: "ja", Kannada: "kn",
  Kazakh: "kk", Korean: "ko", Latvian: "lv", Lithuanian: "lt",
  Malay: "ms", Malayalam: "ml", Marathi: "mr", Norwegian: "no",
  Persian: "fa", Polish: "pl", Portuguese: "pt", Punjabi: "pa",
  Romanian: "ro", Russian: "ru", Serbian: "sr", Slovak: "sk",
  Slovenian: "sl", Spanish: "es", Swahili: "sw", Swedish: "sv",
  Tamil: "ta", Telugu: "te", Thai: "th", Turkish: "tr",
  Ukrainian: "uk", Urdu: "ur", Vietnamese: "vi", Welsh: "cy",
  Zulu: "zu"
};

const badWords = [
  "bitch",
  "slut",
  "whore",
  "porn",
  "sex",
  "pussy",
  "dick",
  "cock",
  "rape",
  "retard",
  "nigger"
];

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Voxlify server",
    online: io.of("/").sockets.size,
    waiting: waitingUsers.length,
    rooms: userRooms.size / 2
  });
});

function getSocketIP(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return socket.handshake.address || "unknown";
}

function getBanKey(socket) {
  const ip = getSocketIP(socket);
  const fp = socket.data?.fingerprint || "no-fingerprint";
  return `${fp}|${ip}`;
}

function isBanned(socket) {
  const ip = getSocketIP(socket);
  const fp = socket.data?.fingerprint;

  return bannedIPs.has(ip) || (fp && bannedFingerprints.has(fp));
}

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

function cleanupSocket(socket, options = {}) {
  removeFromWaiting(socket.id);

  const roomId = userRooms.get(socket.id);

  if (roomId) {
    const clients = io.sockets.adapter.rooms.get(roomId);

    if (clients) {
      for (const id of clients) {
        userRooms.delete(id);

        const s = io.sockets.sockets.get(id);
        if (s) s.leave(roomId);

        if (id !== socket.id) {
          io.to(id).emit("partner-left", {
            manualStop: options.manualStop === true
          });
        }
      }
    }
  }

  userRooms.delete(socket.id);
  busySockets.delete(socket.id);
}

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
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    return pattern.test(clean);
  });
}

function banSocket(socket, reason = "moderation") {
  const ip = getSocketIP(socket);
  const fp = socket.data?.fingerprint;

  bannedIPs.add(ip);
  if (fp) bannedFingerprints.add(fp);

  socket.emit("moderation-banned", { reason });

  cleanupSocket(socket);
  socket.disconnect(true);
}

function handleModeration(socket, text) {
  if (isBanned(socket)) {
    banSocket(socket, "already_banned");
    return { banned: true };
  }

  if (!containsBadWord(text)) {
    return { ok: true };
  }

  const key = getBanKey(socket);
  const count = (warnings.get(key) || 0) + 1;
  warnings.set(key, count);

  if (count >= 2) {
    banSocket(socket, "bad_language");
    return { banned: true };
  }

  socket.emit("moderation-warning", {
    count,
    message: "Warning: inappropriate language is not allowed. Next violation will disconnect you."
  });

  return { warning: true };
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
      headers: { "User-Agent": "Mozilla/5.0" }
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

io.on("connection", socket => {
  console.log("Connected:", socket.id, getSocketIP(socket));

  profiles.set(socket.id, {
    country: null,
    gender: "any",
    speakLanguage: "English"
  });

  emitOnlineCount();

  socket.on("register-fingerprint", data => {
    socket.data.fingerprint = String(data?.fingerprint || "").slice(0, 120);

    if (isBanned(socket)) {
      banSocket(socket, "fingerprint_or_ip_banned");
    }
  });

  socket.on("get-online-count", emitOnlineCount);

  socket.on("update-preferences", data => {
    if (isBanned(socket)) return banSocket(socket, "banned");

    const old = profiles.get(socket.id) || {};

    profiles.set(socket.id, {
      ...old,
      country: data?.country || old.country || null,
      gender: data?.gender || old.gender || "any",
      speakLanguage: data?.speakLanguage || old.speakLanguage || "English"
    });
  });

  socket.on("find-match", data => {
    if (isBanned(socket)) return banSocket(socket, "banned");
    if (userRooms.has(socket.id)) return;

    removeFromWaiting(socket.id);

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

      if (
        candidateSocket &&
        !userRooms.has(candidateId) &&
        !isBanned(candidateSocket)
      ) {
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
    cleanupSocket(socket, {
      manualStop: data?.manualStop === true
    });

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

      const moderation = handleModeration(socket, cleanText);

      if (moderation.banned || moderation.warning) {
        return;
      }

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

  socket.on("report-user", ({ roomId, screenshot }) => {
    if (!roomId) return;

    const now = Date.now();
    const last = lastReport.get(socket.id) || 0;

    if (now - last < 10000) return;

    lastReport.set(socket.id, now);

    const partnerId = getPartnerId(roomId, socket.id);
    if (!partnerId) return;

    const targetSocket = io.sockets.sockets.get(partnerId);
    if (!targetSocket) return;

    const targetKey = getBanKey(targetSocket);
    const count = (reports.get(targetKey) || 0) + 1;
    reports.set(targetKey, count);

    console.log("REPORT:", {
      reporter: socket.id,
      target: partnerId,
      targetIp: getSocketIP(targetSocket),
      targetFp: targetSocket.data?.fingerprint || null,
      count,
      hasScreenshot: Boolean(screenshot)
    });

    targetSocket.emit("moderation-warning", {
      count,
      message: "You have been reported by another user. Next reports may disconnect you."
    });

    if (count >= 2) {
      banSocket(targetSocket, "reports");
    }

    socket.emit("report-received", {
      ok: true
    });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    cleanupSocket(socket);
    profiles.delete(socket.id);
    busySockets.delete(socket.id);
    removeFromWaiting(socket.id);

    emitOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Voxlify server running on port ${PORT}`);
});
