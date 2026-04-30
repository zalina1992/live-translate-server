const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

app.get("/", (req, res) => {
  res.send("Live Translate WebRTC Server is running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let waitingUser = null;

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("find-match", () => {
    if (waitingUser && waitingUser !== socket.id) {
      const roomId = `room-${waitingUser}-${socket.id}`;

      socket.join(roomId);
      io.sockets.sockets.get(waitingUser)?.join(roomId);

      io.to(waitingUser).emit("matched", {
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

  socket.on("disconnect", () => {
    if (waitingUser === socket.id) waitingUser = null;
    socket.broadcast.emit("partner-left");
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});