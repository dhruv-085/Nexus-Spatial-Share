import xxhash from 'xxhash-wasm';

interface HashRequest {
  id: number;
  payload: Uint8Array;
}

let hasherReady: any = null;
// Queue requests that arrive before WASM is loaded
const pendingQueue: HashRequest[] = [];

let isFallback = false;

xxhash().then(h => {
  hasherReady = h;
  // Drain any requests that arrived before we were ready
  for (const req of pendingQueue) {
    const hash = hasherReady.h64Raw(req.payload);
    (self as any).postMessage({ id: req.id, hash });
  }
  pendingQueue.length = 0;
  self.postMessage({ type: 'READY' });
}).catch(err => {
  console.error('[HasherWorker] xxhash-wasm failed to initialize:', err);
  isFallback = true;
  // Drain pending with fallback hash 0n
  for (const req of pendingQueue) {
    (self as any).postMessage({ id: req.id, hash: 0n });
  }
  pendingQueue.length = 0;
  self.postMessage({ type: 'READY', fallback: true });
});

self.onmessage = (e: MessageEvent) => {
  const { id, payload } = e.data as HashRequest;

  if (!hasherReady) {
    if (isFallback) {
      (self as any).postMessage({ id, hash: 0n });
      return;
    }
    // Buffer until ready instead of rejecting
    pendingQueue.push({ id, payload });
    return;
  }

  const hash = hasherReady.h64Raw(payload);
  // No transfer back — hash is a BigInt (primitive), zero-copy
  (self as any).postMessage({ id, hash });
};
