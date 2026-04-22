import xxhash from 'xxhash-wasm';

interface HashRequest {
  id: number;
  payload: Uint8Array;
}

let hasherReady: any = null;
// Queue requests that arrive before WASM is loaded
const pendingQueue: HashRequest[] = [];

xxhash().then(h => {
  hasherReady = h;
  // Drain any requests that arrived before we were ready
  for (const req of pendingQueue) {
    const hash = hasherReady.h64Raw(req.payload);
    (self as any).postMessage({ id: req.id, hash });
  }
  pendingQueue.length = 0;
  self.postMessage({ type: 'READY' });
});

self.onmessage = (e: MessageEvent) => {
  const { id, payload } = e.data as HashRequest;

  if (!hasherReady) {
    // Buffer until ready instead of rejecting
    pendingQueue.push({ id, payload });
    return;
  }

  const hash = hasherReady.h64Raw(payload);
  // No transfer back — hash is a BigInt (primitive), zero-copy
  (self as any).postMessage({ id, hash });
};
