/**
 * Server-level regression for peer reconnection (fix/peer-reconnect-drop).
 *
 * Three independent rooms prove three server behaviors:
 *
 *  R1 — a clientId replacement must clear a stale lock, and the stale socket's
 *       late disconnect must not notify the healthy pair.
 *        A joins (laptop), B joins (phone). A grabs (room locks). A2 rejoins
 *        with A's clientId on a NEW socket (socket.io gives a new id on
 *        reconnect), replacing A. A2 then re-grabs: it must succeed because the
 *        lock previously owned by the replaced socket was cleared. Current
 *        server never clears the lock on replacement -> A2's grab is silently
 *        ignored -> FAIL. Then stale A disconnects (ping timeout) -> the server
 *        must not emit peer-disconnected/waiting to B or A2.
 *
 *  R2 — a real source departure must clear the lock so the peer can re-grab.
 *        C grabs, then disconnects for real. D must be able to re-grab.
 *        Current server never resets isLocked/sourceId on disconnect -> D's
 *        re-grab is ignored -> FAIL.
 *
 *  R3 — re-joining on the SAME socket must re-broadcast 'ready' to the peer.
 *        E joins, F joins. E re-emits join-room on the same socket id
 *        (isReconnect path). F must receive a fresh 'ready'. Current server
 *        only notifies the reconnecting socket -> F gets nothing -> FAIL.
 *
 * Run:   npm run dev (in one terminal)
 *        node test_reconnect_signaling.cjs
 */
const { io } = require('socket.io-client');

const URL = process.env.TEST_SOCKET_URL || 'https://localhost:3000';
const OPTS = {
  reconnection: false,
  rejectUnauthorized: false, // self-signed dev cert
  timeout: 8000,
};

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const s = io(URL, OPTS);
  const recv = { status: [], peerDisconnected: 0, globalLock: [] };
  s.on('room-status', (d) => recv.status.push(d));
  s.on('peer-disconnected', () => { recv.peerDisconnected += 1; });
  s.on('global-lock', (d) => recv.globalLock.push(d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
    s.on('connect', () => { clearTimeout(t); resolve({ s, recv }); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

function waitFor(fn, desc, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${desc}`));
      setTimeout(check, 50);
    };
    check();
  });
}

const readyCount = (c) => c.recv.status.filter((s) => s.status === 'ready').length;
const lockCount = (c) => c.recv.globalLock.length;
const hasWaitingAfter = (c, before) =>
  c.recv.status.slice(before).some((s) => s.status === 'waiting');

(async () => {
  const results = [];
  const record = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '\n        ' + detail}`);
  };

  const conns = [];
  const track = (c) => { conns.push(c); return c; };
  const join = async (c, room, clientId) => c.s.emit('join-room', { roomCode: room, clientId });

  try {
    // ── R1: replacement clears stale lock; stale disconnect stays silent ────
    try {
      const r1 = String(Math.floor(1000 + Math.random() * 9000));
      const A = track(await connect());
      await join(A, r1, 'laptop');
      await waitFor(() => A.recv.status.some((s) => s.status === 'waiting'), 'R1 A waiting');
      const B = track(await connect());
      await join(B, r1, 'phone');
      await waitFor(() => B.recv.status.some((s) => s.status === 'ready' && s.role === 'offerer'), 'R1 B ready/offerer');
      await waitFor(() => A.recv.status.some((s) => s.status === 'ready' && s.role === 'answerer'), 'R1 A ready/answerer');

      // A grabs — room locks, both see global-lock.
      A.s.emit('grabbed', r1);
      await waitFor(() => lockCount(A) > 0 && lockCount(B) > 0, 'R1 global-lock to both');
      record('R1: grab locks room for both peers', true);

      // A2 rejoins with A's clientId on a NEW socket (reconnect signature).
      const aLocksBefore = lockCount(A);
      const A2 = track(await connect());
      await join(A2, r1, 'laptop');
      await waitFor(() => A2.recv.status.some((s) => s.status === 'ready' && s.role === 'offerer'), 'R1 A2 ready/offerer');
      await waitFor(() => readyCount(B) >= 2, 'R1 B fresh ready re-broadcast');
      record('R1: replaced socket is new offerer and peer gets fresh ready', true);

      // A2 re-grabs — must succeed: replacement must have cleared A's stale lock.
      const a2LocksBefore = lockCount(A2);
      A2.s.emit('grabbed', r1);
      await waitFor(() => lockCount(A2) > a2LocksBefore, 'R1 A2 re-grab locks after replacement');
      record(
        'R1: lock cleared on replacement so reconnected session can re-grab',
        lockCount(A2) > a2LocksBefore,
        `A2 globalLock count=${lockCount(A2)}`
      );

      // Stale A disconnects — healthy pair must not be told the peer left.
      const bStatusBefore = B.recv.status.length;
      A.s.disconnect();
      await WAIT(1500);
      const storm = B.recv.peerDisconnected > 0 || hasWaitingAfter(B, bStatusBefore) ||
                    A2.recv.peerDisconnected > 0;
      record(
        'R1: stale replaced socket disconnect does not notify healthy peers',
        !storm,
        `B peerDisconnected=${B.recv.peerDisconnected} B newWaiting=${hasWaitingAfter(B, bStatusBefore)} A2 peerDisconnected=${A2.recv.peerDisconnected}`
      );
    } catch (err) {
      record('R1 completed without internal error', false, String((err && err.message) || err));
    }

    // ── R2: real source departure clears the lock ───────────────────────────
    try {
      const r2 = String(Math.floor(1000 + Math.random() * 9000));
      const C = track(await connect());
      await join(C, r2, 'laptop2');
      await waitFor(() => C.recv.status.some((s) => s.status === 'waiting'), 'R2 C waiting');
      const D = track(await connect());
      await join(D, r2, 'phone2');
      await waitFor(() => readyCount(D) >= 1, 'R2 D ready');
      await waitFor(() => readyCount(C) >= 1, 'R2 C ready');

      C.s.emit('grabbed', r2);
      await waitFor(() => lockCount(C) > 0 && lockCount(D) > 0, 'R2 global-lock to both');
      record('R2: grab locks room for both peers', true);

      C.s.disconnect(); // real departure (source leaves)
      await waitFor(() => D.recv.peerDisconnected > 0, 'R2 D notified of departure');
      record('R2: real departure notifies remaining peer', D.recv.peerDisconnected > 0);

      const dLocksBefore = lockCount(D);
      D.s.emit('grabbed', r2);
      await waitFor(() => lockCount(D) > dLocksBefore, 'R2 D re-grab locks after source left');
      record(
        'R2: lock cleared on source disconnect so re-grab succeeds',
        lockCount(D) > dLocksBefore,
        `D globalLock count=${lockCount(D)}`
      );
    } catch (err) {
      record('R2 completed without internal error', false, String((err && err.message) || err));
    }

    // ── R3: same-socket rejoin re-broadcasts ready to the peer ──────────────
    try {
      const r3 = String(Math.floor(1000 + Math.random() * 9000));
      const E = track(await connect());
      await join(E, r3, 'laptop3');
      await waitFor(() => E.recv.status.some((s) => s.status === 'waiting'), 'R3 E waiting');
      const F = track(await connect());
      await join(F, r3, 'phone3');
      await waitFor(() => readyCount(E) >= 1, 'R3 E ready');
      await waitFor(() => readyCount(F) >= 1, 'R3 F ready');

      const fReadyBefore = readyCount(F);
      E.s.emit('join-room', { roomCode: r3, clientId: 'laptop3' }); // same socket -> isReconnect
      await waitFor(() => readyCount(F) > fReadyBefore, 'R3 F fresh ready');
      record(
        'R3: re-joining socket re-broadcasts ready to the staying peer',
        readyCount(F) > fReadyBefore,
        `F ready count=${readyCount(F)}`
      );
    } catch (err) {
      record('R3 completed without internal error', false, String((err && err.message) || err));
    }
  } finally {
    conns.forEach((c) => { try { c.s.disconnect(); } catch (_) {} });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} signaling checks passed`);
  process.exit(failed.length ? 1 : 0);
})();