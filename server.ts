import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import fs from "fs";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { ExpressPeerServer } from "peer";

async function startServer() {
  const app = express();
  
  let httpServer;
  const isHttps = fs.existsSync('cert.key') && fs.existsSync('cert.crt');
  
  if (isHttps) {
    const options = {
      key: fs.readFileSync('cert.key'),
      cert: fs.readFileSync('cert.crt')
    };
    httpServer = createHttpsServer(options, app);
    console.log("✅ Starting server with HTTPS...");
  } else {
    httpServer = createHttpServer(app);
    console.log("⚠️ Starting server with HTTP... (No certs found)");
  }
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Set up PeerJS Server
  const peerServer = ExpressPeerServer(httpServer, {
    path: "/"
  });
  app.use("/peerjs", peerServer);

  // Extend room structure to track precise peer lists for WebRTC
  const rooms = new Map<string, { isLocked: boolean, sourceId: string | null, peers: string[], offererSocketId: string | null }>();
  const socketToRoom = new Map<string, string>();

  // Socket.io Signaling Logic
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomCode) => {
      socket.join(roomCode);
      socketToRoom.set(socket.id, roomCode);

      let room = rooms.get(roomCode);

      if (!room) {
        // First peer — create room, this peer is the ANSWERER (waits for offer)
        room = { isLocked: false, sourceId: null, peers: [socket.id], offererSocketId: null };
        rooms.set(roomCode, room);
        socket.emit('room-status', { status: 'waiting', role: 'answerer' });
        console.log(`[Server] Room ${roomCode} created, waiting for second peer`);
        
        // Notify others in the room
        socket.to(roomCode).emit("user-joined", socket.id);
        return;
      }

      const isReconnect = room.peers.includes(socket.id);

      if (room.peers.length === 1 && !isReconnect) {
        // Second peer joins — assign roles deterministically
        room.peers.push(socket.id);
        room.offererSocketId = socket.id; // second peer to join is always offerer
        
        // Tell second peer to create and send offer
        socket.emit('room-status', { status: 'ready', role: 'offerer' });
        // Tell first peer to expect an offer
        io.to(room.peers[0]).emit('room-status', { status: 'ready', role: 'answerer' });
        console.log(`[Server] Room ${roomCode} full — starting negotiation`);

        // Notify others in the room
        socket.to(roomCode).emit("user-joined", socket.id);
        return;
      }

      // If reconnecting, let them replace their connection without kicking
      if (isReconnect) {
        socket.emit('room-status', { status: room.peers.length === 2 ? 'ready' : 'waiting', role: room.offererSocketId === socket.id ? 'offerer' : 'answerer' });
        return;
      }

      // Room already has 2 peers — reject the join
      socket.emit('room-status', { status: 'full' });
    });

    // ── WebRTC Signaling Relays ──────────────────────────────────────────────────
    socket.on("offer", ({ roomId, sdp }) => {
      socket.to(roomId).emit("offer", { sdp });
    });
    
    socket.on("answer", ({ roomId, sdp }) => {
      socket.to(roomId).emit("answer", { sdp });
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
      socket.to(roomId).emit("ice-candidate", { candidate });
    });


    socket.on("grabbed", (roomCode) => {
      const room = rooms.get(roomCode);
      if (room && !room.isLocked) {
        room.isLocked = true;
        room.sourceId = socket.id;
        console.log(`Grab event in room: ${roomCode} by ${socket.id}`);
        io.in(roomCode).emit("global-lock", { sourceId: socket.id });
      }
    });

    socket.on("dropped", (roomCode) => {
      const room = rooms.get(roomCode);
      if (room && room.isLocked) {
        room.isLocked = false;
        room.sourceId = null;
        console.log(`Drop event in room: ${roomCode}`);
        io.in(roomCode).emit("global-unlock");
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;

      socketToRoom.delete(socket.id);
      
      const room = rooms.get(roomId);
      if (!room) return;

      // Notify the OTHER peer that their partner disconnected
      room.peers.forEach(peerId => {
        if (peerId !== socket.id) {
          io.to(peerId).emit('peer-disconnected');
        }
      });

      // CRITICAL: Fully delete the room, not just remove the peer
      // This forces both peers to start fresh negotiation on rejoin
      rooms.delete(roomId);
      console.log(`[Server] Room ${roomId} destroyed on peer disconnect`);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    const protocol = isHttps ? "https" : "http";
    console.log(`Nexus Server running on ${protocol}://localhost:${PORT}`);
    console.log(`To access on your phone, go to: ${protocol}://YOUR_LOCAL_IP:${PORT}`);
  });

  // Server side — ping all sockets in rooms every 30 seconds
  setInterval(() => {
    rooms.forEach((room, roomId) => {
      room.peers.forEach(peerId => {
        const peerSocket = io.sockets.sockets.get(peerId);
        if (!peerSocket || !peerSocket.connected) {
          console.log(`[Server] Zombie peer ${peerId} detected in room ${roomId} — cleaning up`);
          room.peers = room.peers.filter(id => id !== peerId);
          // Notify remaining peers
          room.peers.forEach(remainingId => {
            io.to(remainingId).emit('peer-disconnected');
          });
          if (room.peers.length === 0) {
            rooms.delete(roomId);
          }
        }
      });
    });
  }, 30000);
}

startServer();
