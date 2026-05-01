const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Voxlify text translation server",
    online: io.engine.clientsCount || 0
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 15000
});

let waitingUser = null;
const userRooms = new Map();
const busySockets = new Set();

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

async function translateText(text, targetLanguage = "Polish") {
  const target = languageMap[targetLanguage] || "pl";

  const response = await fetch("https://libretranslate.de/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: text,
      source: "auto",
      target,
      format: "text"
    })
  });

  if (!response.ok) {
    throw new Error("Translation service unavailable");
  }

  const data = await response.json();
  return data.translatedText || "";
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

  socket.on("speech-interim", ({ roomId, text }) => {
    if (!roomId || !text) return;

    socket.to(roomId).emit("peer-typing", {
      text
    });
  });

  socket.on("speech-final", async ({ roomId, text, targetLanguage }) => {
    try {
      if (!roomId || !text) return;
      if (busySockets.has(socket.id)) return;

      busySockets.add(socket.id);

      const cleanText = String(text).trim().slice(0, 500);
      if (!cleanText) return;

      const translated = await translateText(
        cleanText,
        targetLanguage || "Polish"
      );

      socket.to(roomId).emit("translation-result", {
        original: cleanText,
        translated,
        targetLanguage: targetLanguage || "Polish"
      });
    } catch (error) {
      console.error("Translation error:", error.message);

      socket.emit("translation-error", {
        message: "Translation temporarily unavailable."
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
