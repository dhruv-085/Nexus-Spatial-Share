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

  // Grace-period timers: if a peer disconnects, we wait before destroying the room
  // so a brief Socket.IO reconnect (WebSocket upgrade failure → polling fallback) doesn't kill the session.
  const pendingDestroyTimers = new Map<string, ReturnType<typeof setTimeout>>(); // roomId → timer

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
        socket.emit('room-status', { status: 'waiting', role: 'answerer', code: roomCode });
        console.log(`[Server] Room ${roomCode} created, waiting for second peer`);
        socket.to(roomCode).emit("user-joined", socket.id);

        // Cancel any pending destroy for this room (peer rejoined in time!)
        const existingTimer = pendingDestroyTimers.get(roomCode);
        if (existingTimer) {
          clearTimeout(existingTimer);
          pendingDestroyTimers.delete(roomCode);
          console.log(`[Server] Room ${roomCode}: destroy timer cancelled — peer rejoined`);
        }
        return;
      }

      // ── Purge TRULY dead peers (socket object gone entirely) ─────────────────
      // Only remove peers whose socket no longer exists in the registry.
      // We do NOT filter on peerSocket.connected because that can be transiently
      // false during mobile network switches, WebSocket re-handshakes, or React
      // StrictMode re-mounts that haven't completed reconnect yet.
      // The "disconnect" server event is the authoritative cleanup — we only
      // use the purge as a safety net for sockets that vanished without firing it.
      const genuinelyDeadPeers = room.peers.filter(peerId => {
        if (peerId === socket.id) return false; // self is never "dead"
        return io.sockets.sockets.get(peerId) == null; // socket object is gone entirely
      });

      if (genuinelyDeadPeers.length > 0) {
        room.peers = room.peers.filter(id => !genuinelyDeadPeers.includes(id));
        console.log(`[Server] Room ${roomCode}: purged ${genuinelyDeadPeers.length} dead peer(s), ${room.peers.length} remain`);
      }

      const isReconnect = room.peers.includes(socket.id);

      // Cancel any pending destroy for this room (peer rejoined in time!)
      const existingTimer2 = pendingDestroyTimers.get(roomCode);
      if (existingTimer2) {
        clearTimeout(existingTimer2);
        pendingDestroyTimers.delete(roomCode);
        console.log(`[Server] Room ${roomCode}: destroy timer cancelled — peer rejoined in grace window`);
      }

      if (room.peers.length === 0) {
        // Room was empty after purge — treat as fresh first join
        room.peers = [socket.id];
        room.offererSocketId = null;
        socket.emit('room-status', { status: 'waiting', role: 'answerer', code: roomCode });
        console.log(`[Server] Room ${roomCode} reclaimed after purge, waiting for second peer`);
        socket.to(roomCode).emit("user-joined", socket.id);
        return;
      }

      if (room.peers.length === 1 && !isReconnect) {
        // Second peer joins — assign roles deterministically
        // Capture the first peer's ID BEFORE pushing, so notification goes to the right socket
        const firstPeerId = room.peers[0];
        room.peers.push(socket.id);
        room.offererSocketId = socket.id; // second peer to join is always offerer

        // Tell second peer to create and send offer
        socket.emit('room-status', { status: 'ready', role: 'offerer', code: roomCode });
        // Tell first peer to expect an offer
        io.to(firstPeerId).emit('room-status', { status: 'ready', role: 'answerer', code: roomCode });
        console.log(`[Server] Room ${roomCode} ready — offerer: ${socket.id}, answerer: ${firstPeerId}`);
        socket.to(roomCode).emit("user-joined", socket.id);
        return;
      }

      // If reconnecting, let them resume without kicking
      if (isReconnect) {
        socket.emit('room-status', {
          status: room.peers.length === 2 ? 'ready' : 'waiting',
          role: room.offererSocketId === socket.id ? 'offerer' : 'answerer',
          code: roomCode
        });
        console.log(`[Server] Reconnect: ${socket.id} rejoining room ${roomCode}`);
        return;
      }

      // Room genuinely has 2 active peers — reject the join
      console.log(`[Server] Room ${roomCode} is full (${room.peers.join(', ')}) — rejecting ${socket.id}`);
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

      // ── Grace-period disconnect handling ─────────────────────────────────────
      // Mobile devices frequently drop their Socket.IO WebSocket connection and
      // reconnect via polling (self-signed cert, network switch, background tab).
      // Instead of instantly destroying the room, wait 12 seconds. If the same
      // room code is rejoined within that window, the session is preserved.
      // We give a generous 2 minutes because users browsing files on mobile 
      // can take a while, and the app goes to background.
      const GRACE_MS = 120_000;

      console.log(`[Server] ${socket.id} disconnected from room ${roomId} — starting ${GRACE_MS/1000}s grace timer`);

      // Cancel any existing timer for this room (avoid double-destroy)
      const existing = pendingDestroyTimers.get(roomId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        pendingDestroyTimers.delete(roomId);
        const currentRoom = rooms.get(roomId);
        if (!currentRoom) return; // already cleaned up

        // Notify remaining peers
        currentRoom.peers.forEach(peerId => {
          if (peerId !== socket.id) {
            console.log(`[Server] Grace expired — notifying ${peerId} of peer disconnect in room ${roomId}`);
            io.to(peerId).emit('peer-disconnected');
          }
        });

        rooms.delete(roomId);
        console.log(`[Server] Room ${roomId} destroyed after grace period`);
      }, GRACE_MS);

      pendingDestroyTimers.set(roomId, timer);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });

    app.get('*', async (req, res, next) => {
      const url = req.originalUrl;
      // Let Vite HMR and module loading fall through to vite.middlewares
      if (url.startsWith('/src/') || url.startsWith('/@') || url.includes('.')) {
        return next();
      }
      console.log(`[DevServer] Intercepted HTML request: ${url}`);
      try {
        const indexHtmlPath = path.resolve(process.cwd(), 'index.html');
        let html = fs.readFileSync(indexHtmlPath, 'utf-8');
        console.log(`[DevServer] Original HTML length: ${html.length}`);
        html = await vite.transformIndexHtml(url, html);
        if (!html.includes('__vite_plugin_react_preamble_installed__')) {
          console.log('[DevServer] Injecting React Refresh preamble manually');
          const preamble = `
<script type="module">
  import { injectIntoGlobalHook } from "/@react-refresh";
  injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>
          `;
          html = html.replace('<title>Nexus Spatial</title>', '<title>Nexus Spatial</title>' + preamble);
        }
        console.log(`[DevServer] Transformed HTML length: ${html.length}`);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        console.error(`[DevServer] Transform error:`, e);
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
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
}

startServer();
