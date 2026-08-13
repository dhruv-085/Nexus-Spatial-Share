/**
 * U2 (R4/AE3) unit proof for TransferEngine's manifest truthfulness guard.
 *
 * Proves canProduceManifest()/getReceivedManifest() without a browser:
 *  - a live receiver mid-transfer reports both flushed and buffered chunks;
 *  - a receiver whose stream writer closed reports [] (restart from 0).
 *
 * Run: npx tsx test_engine_resume_guard.ts
 */
import { TransferEngine, CHUNK_SIZE } from './src/lib/TransferEngine';

function makePacket(index: number, payloadSize = 8): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + payloadSize);
  const v = new DataView(buf);
  v.setUint32(0, index, true);
  v.setBigUint64(4, 0n, true);
  v.setUint8(12, 0);
  v.setUint32(13, payloadSize, true);
  return buf;
}
const HEADER = 17;

function mockWriter() {
  return {
    write: async () => {},
    close: async () => {},
  } as unknown as FileSystemWritableFileStream;
}

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

(async () => {
  // ── Scenario 1: mid-transfer, chunks buffered in RAM ─────────────────────
  {
    const engine = new TransferEngine([]);
    engine.initReceiver({ name: 'a.bin', type: 'application/octet-stream', size: CHUNK_SIZE * 4, totalChunks: 4, chunkSize: CHUNK_SIZE });
    engine.setStreamWriter(mockWriter()); // NOTE: after initReceiver (which resets it)
    engine.enqueueChunk(makePacket(0));
    engine.enqueueChunk(makePacket(1));
    engine.enqueueChunk(makePacket(2));
    await new Promise(r => setTimeout(r, 50));
    check('manifest truthy while writer live', engine.canProduceManifest());
    const m = engine.getReceivedManifest();
    check('mid-transfer manifest includes buffered chunks', m.includes(2) && m.includes(1) && m.includes(0), `manifest=${m}`);
    engine.cancel();
  }

  // ── Scenario 2 (AE3): stream writer closed after chunks were flushed ─────
  {
    const engine = new TransferEngine([]);
    // 100 chunks × 128 KB = 12.8 MB file. Sending ~40 chunks trips the 4 MB
    // WRITE_BATCH_BYTES flush boundary, so a real flush happens mid-transfer.
    const chunkSize = CHUNK_SIZE;
    const totalChunks = 100;
    engine.initReceiver({ name: 'b.bin', type: 'application/octet-stream', size: chunkSize * totalChunks, totalChunks, chunkSize });
    engine.setStreamWriter(mockWriter()); // NOTE: after initReceiver (which resets it)
    for (let i = 0; i < 40; i++) engine.enqueueChunk(makePacket(i, chunkSize));
    await new Promise(r => setTimeout(r, 300));
    // Some chunks flushed to the (mock) writer, later ones still in RAM.
    const before = engine.getReceivedManifest();
    check('flushed-but-writer-live manifest covers all received chunks', before.length === 40, `manifest=${before}`);
    check('guard stays truthful while writer live after a real flush', engine.canProduceManifest());
    engine.setStreamWriter(null); // writer closed (receiver reset while backgrounded)
    check('guard fails once writer closed after flush', engine.canProduceManifest() === false);
    const m = engine.getReceivedManifest();
    check('empty manifest after writer closed (AE3)', Array.isArray(m) && m.length === 0, `manifest=${m}`);
    engine.cancel();
  }

  // ── Scenario 3: no fileMeta (engine never initialized) ───────────────────
  {
    const engine = new TransferEngine([]);
    check('guard fails with no fileMeta', engine.canProduceManifest() === false);
    check('manifest empty with no fileMeta', engine.getReceivedManifest().length === 0);
    engine.cancel();
  }

  console.log(failures === 0 ? '\nAll U2 engine-guard checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();