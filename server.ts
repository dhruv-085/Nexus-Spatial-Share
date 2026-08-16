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

function isValidRoomCode(code: any): boolean {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (trimmed.length < 1 || trimmed.length > 16) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

function isValidClientId(id: any): boolean {
  if (id == null) return true;
  return typeof id === 'string' && id.length > 0 && id.length <= 64;
}

function isValidSDP(sdp: any): boolean {
  if (!sdp || typeof sdp !== 'object') return false;
  try {
    const str = JSON.stringify(sdp);
    return str.length <= 262144; // 256 KB
  } catch (_) {
    return false;
  }
}

function isValidCandidate(candidate: any): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  try {
    const str = JSON.stringify(candidate);
    return str.length <= 16384; // 16 KB
  } catch (_) {
    return false;
  }
}

function renderErrorHtml(code: number, title: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>${code} · Nebulo Share</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #08080a;
      color: #f1f5f9;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow: hidden;
      position: relative;
    }
    .ambient-glow {
      position: absolute;
      width: 450px;
      height: 450px;
      background: radial-gradient(circle, rgba(6, 182, 212, 0.12) 0%, rgba(139, 92, 246, 0.08) 50%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      filter: blur(60px);
      z-index: 0;
    }
    .card {
      position: relative;
      z-index: 1;
      max-width: 480px;
      width: 100%;
      background: rgba(18, 18, 24, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-radius: 20px;
      padding: 40px 32px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .code-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.25);
      color: #f87171;
      border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.05em;
      margin-bottom: 20px;
    }
    .code-badge.warning {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.25);
      color: #fbbf24;
    }
    .code-badge.info {
      background: rgba(6, 182, 212, 0.12);
      border-color: rgba(6, 182, 212, 0.25);
      color: #38bdf8;
    }
    .title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #ffffff;
      margin-bottom: 12px;
    }
    .desc {
      font-size: 14px;
      line-height: 1.6;
      color: #94a3b8;
      margin-bottom: 28px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 14px 20px;
      background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%);
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(6, 182, 212, 0.3);
      transition: all 0.2s ease;
    }
    .btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(6, 182, 212, 0.45);
    }
    .footer-brand {
      margin-top: 24px;
      font-size: 11px;
      color: #475569;
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="ambient-glow"></div>
  <div class="card">
    <div class="code-badge ${code === 404 ? 'info' : 'warning'}">
      <span>●</span> CODE ${code}
    </div>
    <h1 class="title">${title}</h1>
    <p class="desc">${description}</p>
    <a href="/" class="btn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      Return to Nebulo Share
    </a>
    <div class="footer-brand">Nebulo Share Security Architecture</div>
  </div>
</body>
</html>`;
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

  const PORT = Number(process.env.PORT) || 3000;
  const MAX_ROOMS = 10000;

  // ── CORS Configuration for Split Cloud Deployments (e.g. Cloudflare Pages + Render) ──
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "*";
  const allowedOrigins = allowedOriginsEnv === "*" ? "*" : allowedOriginsEnv.split(',').map(s => s.trim());

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins === "*") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  const ioCorsOrigin = allowedOrigins === "*" ? "*" : allowedOrigins;
  const io = new Server(httpServer, {
    cors: {
      origin: ioCorsOrigin,
      methods: ["GET", "POST"]
    },
    pingTimeout: 120000, // 2 minutes before considering socket dead
    pingInterval: 15000  // ping every 15s
  });

  // ── Full-Stack Security Headers Middleware ──────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.socket.io https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self' ws: wss: http: https: blob: data: stun:* turn:*; img-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:;"
    );
    next();
  });

  // ── JSON Body & URL Encoding Size Limits (Anti-DoS) ────────────────────
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: true, limit: '64kb' }));

  // ── HTTP Sliding-Window Rate Limiter ──────────────────────────────────
  const httpRateLimitMap = new Map<string, { count: number, resetTime: number }>();
  const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  const MAX_HTTP_REQUESTS = 600; // 600 requests per minute per IP

  app.use((req, res, next) => {
    // Never rate limit Vite internal dev modules, HMR, Socket.IO polling, PeerJS, health endpoints, or static assets
    const p = req.path;
    if (
      p === '/healthz' ||
      p === '/api/server-info' ||
      p.startsWith('/socket.io') ||
      p.startsWith('/peerjs') ||
      p.startsWith('/@') ||
      p.startsWith('/src') ||
      p.startsWith('/node_modules') ||
      p.startsWith('/__vite') ||
      /\.(js|css|svg|png|jpg|jpeg|gif|ico|wasm|woff|woff2|ttf|eot)$/i.test(p) ||
      process.env.NODE_ENV !== "production"
    ) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = httpRateLimitMap.get(ip);

    if (!record || now > record.resetTime) {
      httpRateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
      return next();
    }

    record.count++;
    if (record.count > MAX_HTTP_REQUESTS) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      if (req.path.startsWith('/api/')) {
        return res.status(429).json({ error: 'Too Many Requests', retryAfter });
      }
      return res.status(429).send(renderErrorHtml(429, '429 · Sector Bandwidth Throttled', `Rate limit exceeded. Please wait ${retryAfter} seconds before dispatching additional commands.`));
    }

    next();
  });

  // Periodic rate limit cache cleanup (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of httpRateLimitMap.entries()) {
      if (now > record.resetTime) {
        httpRateLimitMap.delete(ip);
      }
    }
  }, 5 * 60 * 1000);

  // Dedicated lightweight health check endpoint for cold-start wakeups and monitors
  app.get("/healthz", (_req, res) => {
    res.status(200).type("text/plain").send("OK");
  });

  // Set up PeerJS Server
  const peerServer = ExpressPeerServer(httpServer, {
    path: "/"
  });
  // Express endpoint for client server-info lookup
  app.get("/api/server-info", (_req, res) => {
    const localIP = getLocalIPAddress();
    const protocol = isHttps ? "https" : "http";
    res.json({ localIP, protocol, port: PORT, status: "online" });
  });

  // ── Automated Keep-Alive Heartbeat (Render/Cloud Free Tier) ───────────────
  const renderExternalUrl = process.env.RENDER_EXTERNAL_URL;
  const keepAliveEnabled = process.env.KEEP_ALIVE === "true" || !!renderExternalUrl;
  if (keepAliveEnabled) {
    const targetUrl = renderExternalUrl 
      ? (renderExternalUrl.endsWith('/') ? `${renderExternalUrl}healthz` : `${renderExternalUrl}/healthz`)
      : `http://localhost:${PORT}/healthz`;
    
    console.log(`[KeepAlive] Automated background keep-alive active for ${targetUrl} (every 12m).`);
    setInterval(async () => {
      try {
        const response = await fetch(targetUrl);
        if (response.ok) {
          console.log(`[KeepAlive] Heartbeat ping success at ${new Date().toISOString()}`);
        } else {
          console.warn(`[KeepAlive] Heartbeat ping returned status ${response.status}`);
        }
      } catch (err: any) {
        console.error(`[KeepAlive] Heartbeat ping error:`, err?.message || err);
      }
    }, 12 * 60 * 1000); // 12 minutes
  }

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

  // Socket event rate limiter per socket
  const socketEventCounts = new Map<string, { count: number, resetTime: number }>();
  const checkSocketRate = (socketId: string): boolean => {
    const now = Date.now();
    const record = socketEventCounts.get(socketId);
    if (!record || now > record.resetTime) {
      socketEventCounts.set(socketId, { count: 1, resetTime: now + 1000 });
      return true;
    }
    record.count++;
    if (record.count > 120) {
      return false; // drop excessive events (> 120/sec)
    }
    return true;
  };

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
      if (!checkSocketRate(socket.id)) {
        console.warn(`[Server Security] Rate limit exceeded on socket ${socket.id}`);
        return;
      }

      let roomCode: string;
      let clientId: string | undefined;

      if (typeof data === 'string') {
        roomCode = data.trim();
      } else if (data && typeof data === 'object') {
        roomCode = typeof data.roomCode === 'string' ? data.roomCode.trim() : '';
        if (isValidClientId(data.clientId)) {
          clientId = typeof data.clientId === 'string' ? data.clientId.trim() : undefined;
        }
      } else {
        socket.emit('room-status', { status: 'error', message: 'Invalid room payload' });
        return;
      }

      if (!isValidRoomCode(roomCode)) {
        console.warn(`[Server Security] Invalid room code rejected: "${roomCode}" from socket ${socket.id}`);
        socket.emit('room-status', { status: 'error', message: 'Invalid room code format' });
        return;
      }

      if (!rooms.has(roomCode) && rooms.size >= MAX_ROOMS) {
        console.warn(`[Server Security] Max room capacity reached (${MAX_ROOMS}). Rejecting creation for ${roomCode}`);
        socket.emit('room-status', { status: 'error', message: 'Server is at maximum room capacity' });
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

      // Check if this clientId already exists in the room and seamlessly replace old socket
      if (clientId) {
        const existingPeerSocketId = Array.from(room.peerClientIds.entries())
          .find(([sid, cid]) => cid === clientId)?.[0];
        if (existingPeerSocketId && existingPeerSocketId !== socket.id) {
          console.log(`[Server] ClientId ${clientId} rejoining room ${roomCode} — replacing socket ${existingPeerSocketId} with ${socket.id}`);
          room.peers = room.peers.filter(id => id !== existingPeerSocketId);
          room.peerClientIds.delete(existingPeerSocketId);
          socketToRoom.delete(existingPeerSocketId);

          if (room.sourceId === existingPeerSocketId) {
            room.sourceId = null;
          }

          const oldSocket = io.sockets.sockets.get(existingPeerSocketId);
          if (oldSocket) {
            oldSocket.leave(roomCode);
          }

          room.peers.forEach(peerId => {
            if (peerId !== socket.id) {
              console.log(`[Server] Peer ${clientId} reconnected with new socket — notifying ${peerId} to reset P2P`);
              io.to(peerId).emit('peer-disconnected');
            }
          });
        }
        room.peerClientIds.set(socket.id, clientId);
      }

      // ── Purge TRULY dead peers (socket object gone entirely or disconnected, not matching this clientId) ──
      const genuinelyDeadPeers = room.peers.filter(peerId => {
        if (peerId === socket.id) return false; // self is never "dead"
        const peerSocket = io.sockets.sockets.get(peerId);
        return peerSocket == null || !peerSocket.connected; // socket object is gone entirely or not connected
      });

      if (genuinelyDeadPeers.length > 0) {
        room.peers = room.peers.filter(id => !genuinelyDeadPeers.includes(id));
        genuinelyDeadPeers.forEach(id => room.peerClientIds?.delete(id));
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
        const firstPeerId = room.peers[0];
        room.peers.push(socket.id);
        room.offererSocketId = socket.id; // second peer to join is always offerer

        socket.emit('room-status', { status: 'ready', role: 'offerer', code: roomCode });
        io.to(firstPeerId).emit('room-status', { status: 'ready', role: 'answerer', code: roomCode });
        console.log(`[Server] Room ${roomCode} ready — offerer: ${socket.id}, answerer: ${firstPeerId}`);
        socket.to(roomCode).emit("user-joined", socket.id);
        reassertRoomLock(roomCode);
        return;
      }

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
        reassertRoomLock(roomCode);
        return;
      }

      // Room genuinely has 2 active peers — reject the join
      console.log(`[Server] Room ${roomCode} is full (${room.peers.join(', ')}) — rejecting ${socket.id}`);
      socket.emit('room-status', { status: 'full' });
    });

    // ── WebRTC Signaling Relays with Size & Rate Validation ─────────────────
    socket.on("offer", (payload) => {
      if (!checkSocketRate(socket.id)) return;
      if (!payload || typeof payload !== 'object') return;
      const { roomId, sdp } = payload;
      if (!isValidRoomCode(roomId) || !isValidSDP(sdp)) return;
      if (!rooms.has(roomId)) return;
      socket.to(roomId).emit("offer", { sdp });
    });
    
    socket.on("answer", (payload) => {
      if (!checkSocketRate(socket.id)) return;
      if (!payload || typeof payload !== 'object') return;
      const { roomId, sdp } = payload;
      if (!isValidRoomCode(roomId) || !isValidSDP(sdp)) return;
      if (!rooms.has(roomId)) return;
      socket.to(roomId).emit("answer", { sdp });
    });

    socket.on("ice-candidate", (payload) => {
      if (!checkSocketRate(socket.id)) return;
      if (!payload || typeof payload !== 'object') return;
      const { roomId, candidate } = payload;
      if (!isValidRoomCode(roomId) || !isValidCandidate(candidate)) return;
      if (!rooms.has(roomId)) return;
      socket.to(roomId).emit("ice-candidate", { candidate });
    });

    socket.on("grabbed", (roomCode) => {
      if (!checkSocketRate(socket.id)) return;
      if (!isValidRoomCode(roomCode)) return;
      const room = rooms.get(roomCode);
      if (room && !room.isLocked) {
        room.isLocked = true;
        room.sourceId = socket.id;
        room.sourceClientId = room.peerClientIds?.get(socket.id) ?? null;
        console.log(`Grab event in room: ${roomCode} by ${socket.id}`);
        io.in(roomCode).emit("global-lock", { sourceId: socket.id });
      }
    });

    socket.on("dropped", (roomCode) => {
      if (!checkSocketRate(socket.id)) return;
      if (!isValidRoomCode(roomCode)) return;
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
      if (!checkSocketRate(socket.id)) return;
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
        room.peers.forEach(peerId => {
          console.log(`[Server] Notifying ${peerId} of peer leave in room ${roomId}`);
          io.to(peerId).emit('peer-disconnected');
          io.to(peerId).emit('room-status', { status: 'waiting', role: 'answerer', code: roomId });
        });
        room.isLocked = false;
        room.sourceId = null;
        room.sourceClientId = null;
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      socketEventCounts.delete(socket.id);
      
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;

      socketToRoom.delete(socket.id);
      
      const room = rooms.get(roomId);
      if (!room) return;

      room.peers = room.peers.filter(id => id !== socket.id);
      // Note: We deliberately retain room.peerClientIds across disconnects so the rejoining socket
      // can be recognized by its clientId and seamlessly replace its previous socket reference.
      // Explicit departures (leave-room) and room destruction clean up peerClientIds.

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
        if (!pendingLockTimers.has(roomId) && room.sourceId !== room.peers[0]) {
          room.isLocked = false;
          room.sourceId = null;
          room.sourceClientId = null;
        }
      }
      if (room.offererSocketId === socket.id) {
        room.offererSocketId = room.peers[0] ?? null;
      }

      room.peers.forEach(peerId => {
        console.log(`[Server] User ${socket.id} disconnected — notifying remaining peer ${peerId} in room ${roomId}`);
        io.to(peerId).emit('peer-disconnected');
        io.to(peerId).emit('room-status', { status: 'waiting', role: 'answerer', code: roomId });
      });

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
        const existing = pendingDestroyTimers.get(roomId);
        if (existing) {
          clearTimeout(existing);
          pendingDestroyTimers.delete(roomId);
          console.log(`[Server] Room ${roomId} is active — cancelled pending destroy timer`);
        }
      }
    });
  });

  // Catch-all 404 for unmatched API endpoints
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: "Endpoint Not Found", status: 404, path: req.baseUrl + req.path });
  });

  // Vite middleware for development vs Static files for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.ENABLE_HMR === 'true' ? { server: httpServer } : false,
      },
      appType: "custom",
    });

    // 1. Mount vite.middlewares FIRST so Vite handles module imports, HMR, assets, dependencies
    app.use(vite.middlewares);

    // 2. Any non-module request falls through to serve transformed index.html
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        const indexHtmlPath = path.resolve(process.cwd(), 'index.html');
        let html = fs.readFileSync(indexHtmlPath, 'utf-8');
        html = await vite.transformIndexHtml(url, html);
        
        const preamble = `
<script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>
`;
        const localIP = getLocalIPAddress();
        const ipScript = `\n<script>window.__SERVER_LOCAL_IP__ = "${localIP}";</script>`;
        if (!html.includes('__vite_plugin_react_preamble_installed__')) {
          html = html.replace('<head>', '<head>' + preamble);
        }
        if (!html.includes('__SERVER_LOCAL_IP__')) {
          html = html.replace('<title>Nebulo Share</title>', '<title>Nebulo Share</title>' + ipScript);
        }
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        console.error(`[DevServer] Transform error:`, e);
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
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
          html = html.replace('<title>Nebulo Share</title>', '<title>Nebulo Share</title>' + ipScript);
        }
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } else {
        res.status(404).send(renderErrorHtml(404, '404 · Page Not Found', 'The requested Nebulo Share asset or route was not found on this deployment.'));
      }
    });
  }

  // ── Global Express 500 Error Handler ────────────────────────────────────
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`[Server Subsystem Error] ${req.method} ${req.url}:`, err);
    if (res.headersSent) {
      return next(err);
    }
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: "Internal Server Error", status: 500 });
    }
    res.status(500).send(renderErrorHtml(500, '500 · Server Subsystem Error', 'An unexpected system anomaly occurred within the peer network bridge.'));
  });

  httpServer.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
      console.error(`👉 To free port ${PORT} on Windows PowerShell, run:`);
      console.error(`   Get-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess | Stop-Process -Force\n`);
      process.exit(1);
    } else {
      console.error(`[Server Listen Error]:`, err);
      process.exit(1);
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    const protocol = isHttps ? "https" : "http";
    const localIP = getLocalIPAddress();
    console.log(`Nebulo Share Server running on ${protocol}://localhost:${PORT}`);
    console.log(`To access on your phone, go to: ${protocol}://${localIP}:${PORT}`);
  });
}

startServer();
