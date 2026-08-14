import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import fs from "fs";
import os from "os";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { ExpressPeerServer } from "peer";

function getLocalIPAddress(): string {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch (_) {}
  return '127.0.0.1';
}

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
    },
    pingTimeout: 120000, // 2 minutes before considering socket dead
    pingInterval: 15000  // ping every 15s
  });

  const PORT = 3000;

  // Set up PeerJS Server
  const peerServer = ExpressPeerServer(httpServer, {
    path: "/"
  });
  // Express endpoint for client server-info lookup
  app.get("/api/server-info", (_req, res) => {
    const localIP = getLocalIPAddress();
    const protocol = isHttps ? "https" : "http";
    res.json({ localIP, protocol, port: PORT });
  });

  // Extend room structure to track precise peer lists for WebRTC
  const rooms = new Map<string, { isLocked: boolean, sourceId: string | null, sourceClientId: string | null, peers: string[], offererSocketId: string | null, peerClientIds?: Map<string, string> }>();
  const socketToRoom = new Map<string, string>();

  // Grace-period timers: if a peer disconnects, we wait before destroying the room
  // so a brief Socket.IO reconnect (WebSocket upgrade failure → polling fallback) doesn't kill the session.
  const pendingDestroyTimers = new Map<string, ReturnType<typeof setTimeout>>(); // roomId → timer
  // Lock-hold timers: if the peer that grabbed the room disconnects, we keep the
  // lock reserved for a grace window so a mid-transfer reconnect can resume; only
  // if they never return do we release it (so the surviving peer can re-grab).
  const pendingLockTimers = new Map<string, ReturnType<typeof setTimeout>>(); // roomId → timer
  const LOCK_GRACE_MS = process.env.LOCK_GRACE_MS ? Number(process.env.LOCK_GRACE_MS) : 45_000;

  // Socket.io Signaling Logic
  // Re-assert a held lock after a mid-transfer reconnect. The owner is tracked
  // by clientId (stable across socket reconnects). When the room is back to two
  // peers and a lock is still reserved, re-broadcast global-lock so BOTH peers
  // restore their source/receiver roles and can resume the transfer.
  const reassertRoomLock = (roomCode: string) => {
    const room = rooms.get(roomCode);
    if (!room || !room.isLocked || !room.sourceClientId) return;
    const ownerSocketId = Array.from(room.peerClientIds?.entries() ?? [])
      .find(([, cid]) => cid === room.sourceClientId)?.[0];
    if (!ownerSocketId || !room.peers.includes(ownerSocketId)) return;

    room.sourceId = ownerSocketId;
    const lockTimer = pendingLockTimers.get(roomCode);
    if (lockTimer) {
      clearTimeout(lockTimer);
      pendingLockTimers.delete(roomCode);
    }
    console.log(`[Server] Re-asserting lock for room ${roomCode} to socket ${ownerSocketId} (clientId ${room.sourceClientId})`);
    io.in(roomCode).emit('global-lock', { sourceId: ownerSocketId });
  };

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    socket.emit("server-info", {
      localIP: getLocalIPAddress(),
      protocol: isHttps ? "https" : "http",
      port: PORT
    });

    socket.on("join-room", (data) => {
      let roomCode: string;
      let clientId: string | undefined;

      if (typeof data === 'string') {
        roomCode = data;
      } else if (data && typeof data === 'object') {
        roomCode = data.roomCode;
        clientId = data.clientId;
      } else {
        return;
      }

      socket.join(roomCode);
      socketToRoom.set(socket.id, roomCode);

      let room = rooms.get(roomCode);

      if (!room) {
        // First peer — create room, this peer is the ANSWERER (waits for offer)
        room = { 
          isLocked: false, 
          sourceId: null, 
          sourceClientId: null,
          peers: [socket.id], 
          offererSocketId: null,
          peerClientIds: new Map()
        };
        if (clientId) {
          room.peerClientIds.set(socket.id, clientId);
        }
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

      // Ensure peerClientIds map exists
      if (!room.peerClientIds) {
        room.peerClientIds = new Map();
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
        const peerSocket = io.sockets.sockets.get(peerId);
        return peerSocket == null || !peerSocket.connected; // socket object is gone entirely or not connected
      });

      if (genuinelyDeadPeers.length > 0) {
        room.peers = room.peers.filter(id => !genuinelyDeadPeers.includes(id));
        genuinelyDeadPeers.forEach(id => room.peerClientIds.delete(id));
        console.log(`[Server] Room ${roomCode}: purged ${genuinelyDeadPeers.length} dead peer(s), ${room.peers.length} remain`);
      }

      // Check if this clientId already exists in the room
      if (clientId) {
        const existingPeerSocketId = Array.from(room.peerClientIds.entries())
          .find(([sid, cid]) => cid === clientId)?.[0];
        if (existingPeerSocketId && existingPeerSocketId !== socket.id) {
          console.log(`[Server] ClientId ${clientId} rejoining room ${roomCode} — replacing socket ${existingPeerSocketId} with ${socket.id}`);
          room.peers = room.peers.filter(id => id !== existingPeerSocketId);
          room.peerClientIds.delete(existingPeerSocketId);
          socketToRoom.delete(existingPeerSocketId);

          // The replaced socket owned the room lock — it is the SAME clientId
          // reconnecting, so the lock stays reserved. reassertRoomLock() below
          // will point sourceId at the fresh socket and re-broadcast roles.
          // (Previously this cleared the lock, which broke mid-transfer resume.)
          if (room.sourceId === existingPeerSocketId) {
            room.sourceId = null;
          }

          const oldSocket = io.sockets.sockets.get(existingPeerSocketId);
          if (oldSocket) {
            oldSocket.leave(roomCode);
          }

          // This peer dropped and reconnected with a fresh socket. The other
          // peer's WebRTC path to it is dead, but dc.onclose/ICE failure lags
          // real network loss by 30s+, so the staying peer still thinks it is
          // "connected". Notify it now so it resets WebRTC and re-negotiates
          // on the room-status:ready re-broadcast below — otherwise Drop never
          // works again after a blip.
          room.peers.forEach(peerId => {
            if (peerId !== socket.id) {
              console.log(`[Server] Peer ${clientId} reconnected with new socket — notifying ${peerId} to reset P2P`);
              io.to(peerId).emit('peer-disconnected');
            }
          });
        }
        room.peerClientIds.set(socket.id, clientId);
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
        room.isLocked = false;
        room.sourceId = null;
        room.sourceClientId = null;
        const staleLock = pendingLockTimers.get(roomCode);
        if (staleLock) {
          clearTimeout(staleLock);
          pendingLockTimers.delete(roomCode);
        }
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
        // If a lock was being held (mid-transfer reconnect), restore roles now.
        reassertRoomLock(roomCode);
        return;
      }

      // If reconnecting, let them resume without kicking.
      // Broadcast to every peer so the staying side re-learns roles instantly
      // instead of waiting on the client-side health-check (8-24s).
      if (isReconnect) {
        const status = room.peers.length === 2 ? 'ready' : 'waiting';
        if (!room.offererSocketId || !room.peers.includes(room.offererSocketId)) {
          room.offererSocketId = room.peers[0] ?? null;
        }
        room.peers.forEach(peerId => {
          io.to(peerId).emit('room-status', {
            status,
            role: room.offererSocketId === peerId ? 'offerer' : 'answerer',
            code: roomCode
          });
        });
        console.log(`[Server] Reconnect: ${socket.id} rejoining room ${roomCode}`);
        // If a lock was being held (mid-transfer reconnect), restore roles now.
        reassertRoomLock(roomCode);
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
        // Remember the OWNER by clientId — it survives socket reconnects, so a
        // mid-transfer disconnect can re-assert the same grab on rejoin.
        room.sourceClientId = room.peerClientIds?.get(socket.id) ?? null;
        console.log(`Grab event in room: ${roomCode} by ${socket.id}`);
        io.in(roomCode).emit("global-lock", { sourceId: socket.id });
      }
    });

    socket.on("dropped", (roomCode) => {
      const room = rooms.get(roomCode);
      if (room && room.isLocked) {
        room.isLocked = false;
        room.sourceId = null;
        room.sourceClientId = null;
        console.log(`Drop event in room: ${roomCode}`);
        io.in(roomCode).emit("global-unlock");
      }
    });

    socket.on("leave-room", () => {
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;

      console.log(`[Server] User ${socket.id} explicitly leaving room ${roomId}`);
      
      socketToRoom.delete(socket.id);
      socket.leave(roomId);

      const room = rooms.get(roomId);
      if (!room) return;

      room.peers = room.peers.filter(id => id !== socket.id);
      if (room.peerClientIds) {
        room.peerClientIds.delete(socket.id);
      }

      if (room.peers.length === 0) {
        rooms.delete(roomId);
        const timer = pendingDestroyTimers.get(roomId);
        if (timer) {
          clearTimeout(timer);
          pendingDestroyTimers.delete(roomId);
        }
        console.log(`[Server] Room ${roomId} destroyed immediately because it is empty`);
      } else {
        // Notify remaining peers that the user left
        room.peers.forEach(peerId => {
          console.log(`[Server] Notifying ${peerId} of peer leave in room ${roomId}`);
          io.to(peerId).emit('peer-disconnected');
          io.to(peerId).emit('room-status', { status: 'waiting', role: 'answerer', code: roomId });
        });
        // Reset room lock state
        room.isLocked = false;
        room.sourceId = null;
        room.sourceClientId = null;
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;

      socketToRoom.delete(socket.id);
      
      const room = rooms.get(roomId);
      if (!room) return;

      // Immediately remove this socket from the room's active peer lists
      room.peers = room.peers.filter(id => id !== socket.id);
      if (room.peerClientIds) {
        room.peerClientIds.delete(socket.id);
      }

      // Offerer state is always cleared on departure so WebRTC can re-negotiate.
      //
      // Mid-transfer reconnect preservation: if the SOURCE (lock owner) is the
      // one that dropped, we keep the lock reserved under its clientId for a
      // grace window. When that client rejoins, the join-room handler re-asserts
      // the lock and re-broadcasts global-lock, letting both peers restore their
      // roles and resume the transfer. Only if the owner never returns does the
      // timer release the room. If instead a NON-source peer drops leaving one
      // peer behind, the lock survives only when the surviving peer is the owner
      // (their grab is still valid); otherwise the lock is meaningless alone and
      // clears so a fresh grab is possible.
      if (room.sourceId === socket.id) {
        const sourceClientId = room.sourceClientId;
        room.sourceId = null;
        if (sourceClientId) {
          console.log(`[Server] Lock owner ${socket.id} (clientId ${sourceClientId}) disconnected — holding lock for ${LOCK_GRACE_MS/1000}s`);
          const existingLock = pendingLockTimers.get(roomId);
          if (existingLock) clearTimeout(existingLock);
          const lockTimer = setTimeout(() => {
            pendingLockTimers.delete(roomId);
            const lockedRoom = rooms.get(roomId);
            if (lockedRoom && lockedRoom.isLocked && lockedRoom.sourceClientId === sourceClientId) {
              lockedRoom.isLocked = false;
              lockedRoom.sourceId = null;
              lockedRoom.sourceClientId = null;
              console.log(`[Server] Lock owner ${sourceClientId} never returned — releasing lock for room ${roomId}`);
              io.in(roomId).emit('global-unlock');
            }
          }, LOCK_GRACE_MS);
          pendingLockTimers.set(roomId, lockTimer);
        } else {
          room.isLocked = false;
        }
      } else if (room.peers.length < 2) {
        // The non-source peer left, leaving only one peer. If the surviving peer
        // owns the lock, keep it (their grab is still valid); otherwise the room
        // has no valid lock owner and the lock means nothing without a peer.
        if (room.sourceId !== room.peers[0]) {
          room.isLocked = false;
          room.sourceId = null;
          room.sourceClientId = null;
        }
      }
      if (room.offererSocketId === socket.id) {
        room.offererSocketId = room.peers[0] ?? null;
      }

      // Notify any remaining peers immediately so they reset signaling/P2P
      room.peers.forEach(peerId => {
        console.log(`[Server] User ${socket.id} disconnected — notifying remaining peer ${peerId} in room ${roomId}`);
        io.to(peerId).emit('peer-disconnected');
        io.to(peerId).emit('room-status', { status: 'waiting', role: 'answerer', code: roomId });
      });

      // If the room is now completely empty, start the grace timer to destroy it
      if (room.peers.length === 0) {
        const GRACE_MS = 120_000;
        console.log(`[Server] Room ${roomId} is empty — starting ${GRACE_MS/1000}s grace timer to destroy it`);
        
        const existing = pendingDestroyTimers.get(roomId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
          pendingDestroyTimers.delete(roomId);
          rooms.delete(roomId);
          console.log(`[Server] Room ${roomId} destroyed after grace period`);
        }, GRACE_MS);

        pendingDestroyTimers.set(roomId, timer);
      } else {
        // Cancel any pending destroy timer since the room is not empty
        const existing = pendingDestroyTimers.get(roomId);
        if (existing) {
          clearTimeout(existing);
          pendingDestroyTimers.delete(roomId);
          console.log(`[Server] Room ${roomId} is active — cancelled pending destroy timer`);
        }
      }
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
      if (url.startsWith('/src/') || url.startsWith('/@') || /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|json|map)$/i.test(url)) {
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
          const localIP = getLocalIPAddress();
          const ipScript = `\n<script>window.__SERVER_LOCAL_IP__ = "${localIP}";</script>`;
          html = html.replace('<title>Nexus Spatial</title>', '<title>Nexus Spatial</title>' + preamble + ipScript);
        } else {
          const localIP = getLocalIPAddress();
          const ipScript = `\n<script>window.__SERVER_LOCAL_IP__ = "${localIP}";</script>`;
          html = html.replace('<title>Nexus Spatial</title>', '<title>Nexus Spatial</title>' + ipScript);
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
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, 'utf-8');
        const localIP = getLocalIPAddress();
        const ipScript = `\n<script>window.__SERVER_LOCAL_IP__ = "${localIP}";</script>`;
        if (!html.includes('__SERVER_LOCAL_IP__')) {
          html = html.replace('<title>Nexus Spatial</title>', '<title>Nexus Spatial</title>' + ipScript);
        }
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } else {
        res.sendFile(indexPath);
      }
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    const protocol = isHttps ? "https" : "http";
    const localIP = getLocalIPAddress();
    console.log(`Nexus Server running on ${protocol}://localhost:${PORT}`);
    console.log(`To access on your phone, go to: ${protocol}://${localIP}:${PORT}`);
  });
}

startServer();
