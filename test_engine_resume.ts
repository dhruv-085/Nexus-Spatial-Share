/**
 * U3 (sender re-arm) unit proof for TransferEngine.resumeTransfer().
 *
 * Proves the sender can re-seed an in-flight transfer from a receiver's
 * manifest without a browser:
 *  - covered chunks are never re-sent and the pump resumes at the first gap;
 *  - an empty manifest restarts from chunk 0;
 *  - a full manifest completes the transfer;
 *  - resume is a no-op before a start and after a cancel.
 *
 * Run: npx tsx test_engine_resume.ts
 */
import { TransferEngine, CHUNK_SIZE } from './src/lib/TransferEngine';

function readChunkIndex(packet: ArrayBuffer): number {
  return new DataView(packet).getUint32(0, true);
}

function mockConn() {
  const sent: number[] = [];
  const conn = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null as (() => void) | null,
    send(data: ArrayBuffer) {
      sent.push(readChunkIndex(data));
    },
  } as unknown as RTCDataChannel;
  return { conn, sent };
}

function makeFile(totalChunks: number, type = ''): File {
  const bytes = new Uint8Array(totalChunks * CHUNK_SIZE);
  return new File([bytes], 'resume.bin', { type });
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

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── Scenario 1: cover manifest 0..2 → pump resumes at 3, never re-sends 0..2 ─
  {
    const { conn, sent } = mockConn();
    const engine = new TransferEngine([conn]);
    await engine.startTransfer(makeFile(8));
    await settle();
    sent.length = 0; // clear pre-resume sends
    engine.resumeTransfer([0, 1, 2]);
    await settle();
    const postResume = sent.slice();
    check('resume does not re-send covered chunks', postResume.length > 0 && postResume.every(idx => idx > 2), `sent=${postResume}`);
    engine.cancel();
  }

  // ── Scenario 2: empty manifest → restart from 0 ─────────────────────────
  {
    const { conn, sent } = mockConn();
    const engine = new TransferEngine([conn]);
    await engine.startTransfer(makeFile(8));
    await settle();
    sent.length = 0;
    engine.resumeTransfer([]);
    await settle();
    const postResume = sent.slice();
    check('empty manifest restarts from chunk 0', postResume.includes(0), `sent=${postResume}`);
    engine.cancel();
  }

  // ── Scenario 3: full manifest → transfer completes ──────────────────────
  {
    const { conn } = mockConn();
    const engine = new TransferEngine([conn]);
    let completed = false;
    engine.setCallbacks(() => {}, (blob) => {
      if (blob === undefined || blob === null) completed = true;
    });
    await engine.startTransfer(makeFile(8));
    await settle();
    engine.resumeTransfer([0, 1, 2, 3, 4, 5, 6, 7]);
    await settle();
    check('full manifest finishes the send', completed);
    engine.cancel();
  }

  // ── Scenario 4: no-op before start and after cancel ─────────────────────
  {
    const { conn } = mockConn();
    const engine = new TransferEngine([conn]);
    let threw = false;
    try { engine.resumeTransfer([0, 1]); } catch { threw = true; }
    check('resume before start is a silent no-op', !threw);

    await engine.startTransfer(makeFile(8));
    await settle();
    engine.cancel();
    try { engine.resumeTransfer([]); } catch { threw = true; }
    check('resume after cancel is a silent no-op', !threw);
  }

  // ── Scenario 5: gap at chunk K re-sends K and nothing acknowledged ──────
  {
    const { conn, sent } = mockConn();
    const engine = new TransferEngine([conn]);
    await engine.startTransfer(makeFile(8));
    await settle();
    sent.length = 0;
    // Simulate a non-contiguous manifest: chunk 3 never arrived on the receiver.
    engine.resumeTransfer([0, 1, 2, 4, 5, 6, 7]);
    await settle();
    const postResume = sent.slice();
    check('gap chunk is re-sent and nothing else', postResume.length === 1 && postResume[0] === 3, `sent=${postResume}`);
  }

  console.log(failures === 0 ? '\nAll U3 engine resume checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();