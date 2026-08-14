/**
 * Server-level regression for peer reconnection (fix/peer-reconnect-drop).
 *
 * Three independent rooms prove three server behaviors:
 *
 *  R1 — a clientId replacement (same device, new socket) must PRESERVE the lock
 *       so a mid-transfer reconnect can resume; the replaced session's re-grab
 *       is a no-op (the room is already locked by that identity). A stale
 *       socket's late disconnect must not notify the healthy pair.
 *        A joins (laptop), B joins (phone). A grabs (room locks). A2 rejoins
 *        with A's clientId on a NEW socket (socket.io gives a new id on
 *        reconnect), replacing A. The lock stays reserved under 'laptop' and
 *        reassertRoomLock() points sourceId at A2 and re-broadcasts global-lock.
 *        A2's re-grab is therefore ignored (already locked). Then stale A
 *        disconnects (ping timeout) -> the server must not emit
 *        peer-disconnected/waiting to B or A2.
 *
 *  R2 — a real SOURCE departure must NOT clear the lock immediately: it stays
 *        reserved under the owner's clientId for LOCK_GRACE_MS so the owner can
 *        rejoin and resume. Only after the grace window does the room release
 *        and let the surviving peer re-grab. The test uses LOCK_GRACE_MS=1500.
 *
 *  R3 — re-joining on the SAME socket must re-broadcast 'ready' to the peer.
 *        E joins, F joins. E re-emits join-room on the same socket id
 *        (isReconnect path). F must receive a fresh 'ready'. Current server
 *        only notifies the reconnecting socket -> F gets nothing -> FAIL.
 *
 *  R4 — a NON-source departure must PRESERVE the surviving source's lock (the
 *        source keeps its grab so it can resume when the receiver returns);
 *        the source's re-grab is a no-op because it never lost the lock.
 *
 * Run:   LOCK_GRACE_MS=1500 npm run dev  (in one terminal — short grace for R2)
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
  const recv = { status: [], peerDisconnected: 0, globalLock: [], globalUnlock: 0 };
  s.on('room-status', (d) => recv.status.push(d));
  s.on('peer-disconnected', () => { recv.peerDisconnected += 1; });
  s.on('global-lock', (d) => recv.globalLock.push(d));
  s.on('global-unlock', () => { recv.globalUnlock += 1; });
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
      const A2 = track(await connect());
      await join(A2, r1, 'laptop');
      await waitFor(() => A2.recv.status.some((s) => s.status === 'ready' && s.role === 'offerer'), 'R1 A2 ready/offerer');
      await waitFor(() => readyCount(B) >= 2, 'R1 B fresh ready re-broadcast');
      record('R1: replaced socket is new offerer and peer gets fresh ready', true);

      // The lock must survive the replacement (same clientId = same identity) and
      // be re-asserted onto the fresh socket. reassertRoomLock() re-broadcasts
      // global-lock, so A2 sees its own lock restored.
      await waitFor(() => lockCount(A2) > 0, 'R1 lock re-asserted to A2 after replacement');
      const a2LocksAfterReassert = lockCount(A2);

      // A2 re-grabs — must be a NO-OP: the room is already locked by A2's identity.
      A2.s.emit('grabbed', r1);
      await WAIT(800);
      record(
        'R1: lock preserved across replacement (re-grab is a no-op)',
        lockCount(A2) === a2LocksAfterReassert,
        `A2 globalLock count=${lockCount(A2)} (reassert included)`
      );

      // Stale A disconnects — healthy pair must not be told the peer left.
      // Snapshot the counters first: B legitimately received one
      // peer-disconnected during A2's rejoin (the staying peer must reset its
      // WebRTC), so only NEW notifications after this point count as a storm.
      const bStatusBefore = B.recv.status.length;
      const bDisconnectsBefore = B.recv.peerDisconnected;
      const a2DisconnectsBefore = A2.recv.peerDisconnected;
      A.s.disconnect();
      await WAIT(1500);
      const storm = B.recv.peerDisconnected > bDisconnectsBefore || hasWaitingAfter(B, bStatusBefore) ||
                    A2.recv.peerDisconnected > a2DisconnectsBefore;
      record(
        'R1: stale replaced socket disconnect does not notify healthy peers',
        !storm,
        `B peerDisconnected=${B.recv.peerDisconnected} (before ${bDisconnectsBefore}) B newWaiting=${hasWaitingAfter(B, bStatusBefore)} A2 peerDisconnected=${A2.recv.peerDisconnected} (before ${a2DisconnectsBefore})`
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

      // The source's lock stays reserved for the grace window so a mid-transfer
      // reconnect can resume — D's immediate re-grab must be ignored.
      const dLocksBefore = lockCount(D);
      D.s.emit('grabbed', r2);
      await WAIT(800);
      record(
        'R2: lock held for grace window after source departure (re-grab ignored)',
        lockCount(D) === dLocksBefore,
        `D globalLock count=${lockCount(D)} (expected ${dLocksBefore})`
      );

      // After LOCK_GRACE_MS (set to 1500 in the test), the room releases the lock
      // (global-unlock) and the surviving peer can re-grab.
      await waitFor(() => D.recv.globalUnlock > 0, 'R2 lock grace expires (global-unlock)', 6000);
      const dLocksAfterUnlock = lockCount(D);
      D.s.emit('grabbed', r2);
      await waitFor(
        () => lockCount(D) > dLocksAfterUnlock,
        'R2 D re-grab locks after source lock grace expires',
        6000
      );
      record(
        'R2: lock released after grace so re-grab succeeds',
        lockCount(D) > dLocksAfterUnlock,
        `D globalLock count=${lockCount(D)}`
      );
    } catch (err) {
      record('R2 completed without internal error', false, String((err && err.message) || err));
    }

    // ── R4: a non-source departure clears the lock so the source can re-grab ─
    try {
      const r4 = String(Math.floor(1000 + Math.random() * 9000));
      const S = track(await connect());
      await join(S, r4, 'sender');
      await waitFor(() => S.recv.status.some((s) => s.status === 'waiting'), 'R4 S waiting');
      const T = track(await connect());
      await join(T, r4, 'recv');
      await waitFor(() => readyCount(T) >= 1, 'R4 T ready');
      await waitFor(() => readyCount(S) >= 1, 'R4 S ready');

      S.s.emit('grabbed', r4); // source grabs
      await waitFor(() => lockCount(S) > 0 && lockCount(T) > 0, 'R4 global-lock to both');
      record('R4: source grab locks room for both peers', true);

      T.s.disconnect(); // receiver (non-source) departs for real
      await waitFor(() => S.recv.peerDisconnected > 0, 'R4 S notified of departure');
      record('R4: non-source departure notifies remaining peer', S.recv.peerDisconnected > 0);

      // The source keeps its grab when a non-source peer leaves (it never lost
      // ownership) — so its re-grab is a no-op and the lock stays active.
      const sLocksBefore = lockCount(S);
      S.s.emit('grabbed', r4);
      await WAIT(800);
      record(
        'R4: source lock preserved when receiver departs (re-grab is a no-op)',
        lockCount(S) === sLocksBefore,
        `S globalLock count=${lockCount(S)} (expected ${sLocksBefore})`
      );
    } catch (err) {
      record('R4 completed without internal error', false, String((err && err.message) || err));
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