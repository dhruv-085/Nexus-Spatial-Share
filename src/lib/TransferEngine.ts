import LZ4 from 'lz4js';

export interface TransferTelemetry {
  speedMBps: number;
  etaSeconds: number;
  chunksSent: number;
  totalChunks: number;
  retransmits: number;
  inFlight: number;
  progress: number;
  windowSize: number;
}

export interface FileMetadata {
  name: string;
  type: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
}

export const CHUNK_SIZE = 128 * 1024;                 // 128 KB per chunk
export const HEADER_SIZE = 17;                        // 4(idx)+8(hash)+1(flags)+4(origLen)

export function sanitizeFilename(name: string): string {
  if (!name || typeof name !== 'string') {
    return `nexus_file_${Date.now()}`;
  }
  // 1. Strip null bytes & control characters
  let clean = name.replace(/[\x00-\x1f\x7f]/g, '');
  // 2. Normalize and replace path traversal sequences & illegal filesystem characters
  clean = clean.replace(/[/\\?%*:|"<>]/g, '_').replace(/\.\.+/g, '_').trim();
  // 3. Prevent empty/whitespace or dot-only filenames
  if (!clean || clean === '.' || clean === '..') {
    return `nexus_file_${Date.now()}`;
  }
  // 4. Windows reserved device names filtering (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const baseName = clean.split('.')[0].toUpperCase();
  const reserved = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]);
  if (reserved.has(baseName)) {
    clean = `_${clean}`;
  }
  // 5. Truncate long filenames to 255 chars
  if (clean.length > 255) {
    const extIndex = clean.lastIndexOf('.');
    if (extIndex !== -1 && clean.length - extIndex < 16) {
      const ext = clean.substring(extIndex);
      clean = clean.substring(0, 255 - ext.length) + ext;
    } else {
      clean = clean.substring(0, 255);
    }
  }
  return clean || `nexus_file_${Date.now()}`;
}
const PREFETCH_BATCH = 200;                           // 25.6 MB prefetch
const PACKET_CACHE_MAX = 500;                         // 64 MB RAM cap
const BACKPRESSURE_LOW_BYTES  = 1024 * 1024;          // 1 MB — resume pumping
const WINDOW_GROW_STEP = 1;
const STALE_PAUSE_TIMEOUT_MS = 2000;

const COMPRESSIBLE_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'application/javascript',
  'application/json', 'text/csv', 'application/xml', 'image/bmp',
  'image/x-ms-bmp', 'image/svg+xml'
]);

type PacketCache = Map<number, ArrayBuffer>;

export class TransferEngine {
  // Sender state
  private file: File | null = null;
  private connections: RTCDataChannel[] = [];
  private controlConnections: RTCDataChannel[] = [];
  private nextConnIdx = 0;
  private nextCtrlIdx = 0;
  private totalChunks = 0;
  private nextChunkIndex = 0;
  private inFlight = new Set<number>();
  private ackedChunks = new Set<number>();
  private retransmits = 0;
  private isCompressible = false;
  private isSending = false;
  private isCanceled = false;

  private packetCache: PacketCache = new Map();
  private prefetchInProgress = new Set<number>();
  private isPumping = false;
  private isPrefetching = false;

  private backpressurePaused = false;
  private backpressurePausedSince = 0;

  // Network profile
  private networkProfile: 'unknown' | 'lan' | 'wifi' = 'unknown';
  private rttSamples: number[] = [];
  private rttProbeStartTimes: Map<number, number> = new Map();
  private static readonly RTT_SAMPLE_COUNT = 5;
  private static readonly RTT_LAN_THRESHOLD_MS = 5;

  private static readonly PROFILE_LAN = {
    windowFloor: 1024,    // 128 MB static window
    windowCeiling: 1024,  // 128 MB static window
    windowGrowDivisor: 2,
    backpressureLowBytes: 4 * 1024 * 1024,      // 4 MB
    backpressureHighCap: 12 * 1024 * 1024,      // 12 MB max internal buffer
    useMultiChannel: true,
    slowStartThreshold: 512,
  };

  private static readonly PROFILE_WIFI = {
    windowFloor: 64,
    windowCeiling: 384,
    windowGrowDivisor: 4,
    backpressureLowBytes: 1 * 1024 * 1024,   // resume at 1 MB — reliable on Android Chrome under load
    backpressureHighCap: 10 * 1024 * 1024,   // pause at 10 MB — prevents bufferbloat on mobile hotspot
    useMultiChannel: false,
    slowStartThreshold: 128,
  };

  private static readonly PROFILE_RAMP = {
    windowFloor: 16,
    windowCeiling: 512,
    windowGrowDivisor: 2,
    backpressureLowBytes: 2 * 1024 * 1024,
    backpressureHighCap: 8 * 1024 * 1024,
    useMultiChannel: true,
    slowStartThreshold: 64,
  };

  private activeProfile = TransferEngine.PROFILE_RAMP;

  // RAM watchdog
  private ramWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  private staleWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  private lastAckReceivedAt = 0;
  private static readonly RAM_WARN_MB = 400;
  private static readonly RAM_FLUSH_MB = 600;
  private partialBlobs: Blob[] = [];

  // Adaptive window (AIMD)
  private slowStartActive = true;
  private slowStartThreshold = this.activeProfile.slowStartThreshold;
  private dynamicBackpressureHigh = this.activeProfile.windowFloor * CHUNK_SIZE * 1.5;
  private currentWindowSize = this.activeProfile.windowFloor;
  private acksSinceGrow = 0;

  // Receiver state
  private receiveChunksArray: ArrayBuffer[] = [];
  private receivedChunks = new Set<number>();
  private fileMeta: FileMetadata | null = null;
  private streamWriter: FileSystemWritableFileStream | null = null;

  private receiveQueue: ArrayBuffer[] = [];
  private isProcessingQueue = false;
  private lastFlushedIndex = -1;
  private static readonly WRITE_BATCH_BYTES = 4 * 1024 * 1024; // 4 MB

  // Batched ACK state
  private pendingAcks: number[] = [];
  private ackFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly ACK_FLUSH_INTERVAL_MS = 2;  // Reduced from 8ms: prevents phone event-loop saturation from starving ACKs on hotspot/LAN
  private static readonly ACK_FLUSH_COUNT = 32;

  // Telemetry
  private startTime = 0;
  private bytesTransferred = 0;
  private speedSamples: { time: number; bytes: number }[] = [];
  private lastBytesForSpeed = 0;
  private onTelemetryUpdate: ((t: TransferTelemetry) => void) | null = null;
  private onComplete: ((blob?: Blob | null) => void) | null = null;
  private telemetryInterval: ReturnType<typeof setInterval> | null = null;

  // Hasher worker pool
  private hasherWorkers: Worker[] = [];
  private hasherCallbacks = new Map<number, (hash: bigint) => void>();
  private hasherIdCounter = 0;
  private hasherReadyCount = 0;
  private hasherWorkerReady: Promise<void>;
  private hasherWorkerReadyResolve!: () => void;
  private workerRoundRobin = 0;

  constructor(connections: RTCDataChannel[]) {
    this.connections = connections;

    this.hasherWorkerReadyResolve = () => {};
    this.hasherWorkerReady = Promise.resolve();
    // Application-level hashing removed. WebRTC SCTP already guarantees data integrity via CRC32c.
    // This saves massive CPU and RAM bandwidth. 

    // BUG 1 FIX: tune socket buffers after workers are set up
    this.tuneSocketBuffers();
  }

  public setControlConnections(conns: RTCDataChannel[]) {
    this.controlConnections = conns;
    this.tuneSocketBuffers();
  }

  public setConnections(dataConns: RTCDataChannel[], controlConns: RTCDataChannel[]) {
    this.connections = dataConns;
    this.controlConnections = controlConns;
    this.tuneSocketBuffers();
    console.log(`[TransferEngine] Connections updated: ${dataConns.length} data, ${controlConns.length} control`);
    // BUG 13 FIX: resume pump when channels are hot-swapped
    if (this.isSending && !this.isCanceled) {
      this.pumpWindow();
    }
  }

  public setCallbacks(
    onTelemetry: (t: TransferTelemetry) => void,
    onComplete: (blob?: Blob | null) => void
  ) {
    this.onTelemetryUpdate = onTelemetry;
    this.onComplete = onComplete;
  }

  private async hashPayload(payload: Uint8Array): Promise<bigint> {
    // Redundant application-level hashing removed for speed.
    // WebRTC Data Channels (SCTP) have strict CRC32c checksums built-in.
    return 0n;
  }

  // BUG 1 FIX: Access bufferedAmountLowThreshold directly on raw RTCDataChannel,
  // NOT on a non-existent .dataChannel wrapper property.
  public tuneSocketBuffers() {
    for (const conn of this.connections) {
      if (conn && typeof conn.bufferedAmountLowThreshold !== 'undefined') {
        conn.bufferedAmountLowThreshold = this.activeProfile.backpressureLowBytes;
        conn.onbufferedamountlow = () => {
          if (this.backpressurePaused) {
            console.log('[TransferEngine] bufferedamountlow fired — resuming pump');
            this.backpressurePaused = false;
            this.backpressurePausedSince = 0;
            this.pumpWindow();
          }
        };
      }
    }
  }

  private growWindow(): void {
    if (this.currentWindowSize >= this.activeProfile.windowCeiling) return;
    this.acksSinceGrow++;
    const threshold = Math.ceil(this.currentWindowSize / this.activeProfile.windowGrowDivisor);
    if (this.acksSinceGrow < threshold) return;

    this.acksSinceGrow = 0;
    this.currentWindowSize = Math.min(this.activeProfile.windowCeiling, this.currentWindowSize + WINDOW_GROW_STEP);
    this.updateDynamicBackpressure();
    console.log(
      `[Window] ↑ ${this.currentWindowSize} chunks ` +
      `(${(this.currentWindowSize * CHUNK_SIZE / 1048576).toFixed(0)} MB in-flight)`
    );
  }

  private shrinkWindow(): void {
    const prev = this.currentWindowSize;
    if (this.slowStartActive) {
      this.slowStartThreshold = Math.max(Math.floor(this.currentWindowSize * 0.75), this.activeProfile.windowFloor);
      this.slowStartActive = false;
    }
    this.currentWindowSize = Math.max(this.activeProfile.windowFloor, Math.floor(this.currentWindowSize * 0.75));
    this.acksSinceGrow = 0;
    this.updateDynamicBackpressure();
    if (this.currentWindowSize !== prev) {
      console.log(`[Window] ↓ ${prev}→${this.currentWindowSize} chunks (backpressure MD)`);
    }
  }

  private updateDynamicBackpressure() {
    this.dynamicBackpressureHigh = Math.min(
      this.currentWindowSize * CHUNK_SIZE * 1.5,
      this.activeProfile.backpressureHighCap
    );
  }

  // ─── Sender: Public API ───────────────────────────────────────────────────
  public async startTransfer(file: File, resumeManifest: number[] = []) {
    this.isCanceled = false;
    this.file = file;
    this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.nextChunkIndex = 0;
    this.inFlight.clear();
    this.ackedChunks = new Set(resumeManifest);
    this.retransmits = 0;
    this.isCompressible =
      file.size < 100 * 1024 * 1024 &&
      COMPRESSIBLE_TYPES.has(file.type.toLowerCase());
    this.isSending = true;
    this.packetCache.clear();
    this.prefetchInProgress.clear();
    this.isPumping = false;
    this.backpressurePaused = false;
    this.backpressurePausedSince = 0;

    // Always ramp from a conservative floor regardless of detected profile.
    // This prevents blasting the receiver (especially mobile) with 128 MB in-flight
    // from chunk 0. AIMD slow-start grows the window based on actual ACK rate.
    this.activeProfile = TransferEngine.PROFILE_RAMP;
    this.currentWindowSize = TransferEngine.PROFILE_RAMP.windowFloor;
    this.acksSinceGrow = 0;
    this.slowStartActive = true;
    this.slowStartThreshold = TransferEngine.PROFILE_RAMP.slowStartThreshold;
    this.updateDynamicBackpressure();
    // Reset network detection so each transfer re-probes RTT fresh
    this.networkProfile = 'unknown';
    this.rttSamples = [];
    this.rttProbeStartTimes.clear();

    this.startTime = performance.now();
    this.bytesTransferred = resumeManifest.length * CHUNK_SIZE;

    this.startTelemetry();

    // Stale backpressure + inFlight-deadlock watchdog — fires even when zero ACKs arrive (phone→laptop direction)
    if (this.staleWatchdogInterval) { clearInterval(this.staleWatchdogInterval); this.staleWatchdogInterval = null; }
    this.lastAckReceivedAt = 0;
    this.staleWatchdogInterval = setInterval(() => {
      if (!this.isSending || this.isCanceled) return;

      // ── Path A: backpressure pause is stuck ──────────────────────────────
      if (this.backpressurePaused && this.backpressurePausedSince > 0) {
        const elapsed = Date.now() - this.backpressurePausedSince;
        if (elapsed >= 800) {
          const totalBuffered = this.connections.reduce((sum, c) => sum + (c?.bufferedAmount ?? 0), 0);
          if (totalBuffered < this.activeProfile.backpressureLowBytes || this.inFlight.size === 0) {
            // Buffer drained OR all ACKs arrived — safe to resume
            console.warn(`[TransferEngine] Stale backpressure cleared by watchdog (${elapsed}ms, buffered=${totalBuffered}, inFlight=${this.inFlight.size})`);
            this.backpressurePaused = false;
            this.backpressurePausedSince = 0;
            this.pumpWindow();
          } else if (elapsed >= 3000) {
            // Hard timeout: SCTP guarantees the buffer drains eventually.
            // bufferedAmount on Android Chrome can read stale/high under CPU load.
            // Force-clear unconditionally — do not reset the timer.
            console.warn(`[TransferEngine] Hard timeout: force-clearing backpressure after ${elapsed}ms (buffered=${totalBuffered})`);
            this.backpressurePaused = false;
            this.backpressurePausedSince = 0;
            this.pumpWindow();
          }
          // NOTE: no else-reset of backpressurePausedSince — that was the deadlock bug.
        }
      }

      // ── Path B: window full but no ACKs arriving (inFlight deadlock) ────
      if (
        !this.backpressurePaused &&
        this.inFlight.size >= this.currentWindowSize &&
        this.lastAckReceivedAt > 0
      ) {
        const noAckMs = Date.now() - this.lastAckReceivedAt;
        if (noAckMs > 3000) {
          // Window is full and no ACK has arrived in 3s.
          // On hotspot/USB tethering, SCTP can stall ACK delivery asymmetrically.
          // Clearing inFlight is safe: SCTP guarantees chunk delivery, so the
          // receiver already has the data. Any late ACK will be a graceful no-op.
          console.warn(`[TransferEngine] InFlight deadlock: clearing ${this.inFlight.size} stuck slots (${noAckMs}ms no ACK)`);
          this.inFlight.clear();
          this.lastAckReceivedAt = Date.now(); // prevent re-trigger on next tick
          this.pumpWindow();
        }
      }

      // ── Path C: pump went idle with chunks remaining (prefetch race) ─────
      // Scenario: fire-and-forget prefetchBatch() sets isPrefetching=true just
      // before the pump calls await prefetchBatch() for the next chunk. The
      // awaited call returns immediately (isPrefetching guard), cache is still
      // empty, pump breaks. Background prefetch fills cache but inFlight=0
      // means no more ACKs will call pumpWindow. Transfer stalls permanently.
      // The primary fix is in prefetchBatch's finally block; this is the safety net.
      if (
        !this.backpressurePaused &&
        !this.isPumping &&
        !this.isPrefetching &&
        this.inFlight.size === 0 &&
        this.ackedChunks.size < this.totalChunks &&
        this.lastAckReceivedAt > 0
      ) {
        const idleMs = Date.now() - this.lastAckReceivedAt;
        if (idleMs > 400) {
          console.warn(`[TransferEngine] Idle pump: inFlight=0, pump not running, ${this.ackedChunks.size}/${this.totalChunks} done — restarting (${idleMs}ms idle)`);
          this.lastAckReceivedAt = Date.now(); // reset to avoid rapid re-fires
          this.pumpWindow();
        }
      }
    }, 250);

    await this.prefetchBatch();
    this.pumpWindow();
  }

  // U3 (R1/R2/R3): re-seed an in-flight send from a receiver-published manifest.
  // Unlike startTransfer() it does not re-open the file or reset telemetry
  // baselines; it re-seeds ackedChunks, clears in-flight slots, drops prefetched
  // packets the manifest now marks acknowledged, and restarts the pump from the
  // first unacknowledged chunk. The receiver is the sole authority on progress,
  // so covered chunks are simply skipped, never re-read from disk. A no-op when
  // nothing is sending (receiver engine, idle, or cancelled).
  public resumeTransfer(manifest: number[]): void {
    if (!this.isSending || this.isCanceled || !this.file) return;

    this.ackedChunks = new Set(manifest);
    this.inFlight.clear();

    if (this.ackedChunks.size > 0) {
      this.ackedChunks.forEach(idx => this.packetCache.delete(idx));
    }

    let next = 0;
    while (next < this.totalChunks && this.ackedChunks.has(next)) next++;
    this.nextChunkIndex = next;

    this.backpressurePaused = false;
    this.backpressurePausedSince = 0;

    // U3 (AE1): never let the progress ring jump backwards after a resume.
    this.bytesTransferred = Math.max(this.bytesTransferred, this.ackedChunks.size * CHUNK_SIZE);

    // Refresh the ACK clock so the stale-backpressure / inFlight-deadlock
    // watchdog paths do not fire on the first tick after a resume.
    this.lastAckReceivedAt = Date.now();

    if (this.ackedChunks.size >= this.totalChunks) {
      this.finishTransfer();
      return;
    }

    this.pumpWindow();
    this.prefetchBatch();
  }

  private async prefetchBatch() {
    if (!this.file || this.isCanceled || this.isPrefetching) return;
    this.isPrefetching = true;

    try {
      const tasks: Promise<void>[] = [];
      let scheduled = 0;

      for (
        let idx = this.nextChunkIndex;
        idx < this.totalChunks && scheduled < PREFETCH_BATCH;
        idx++
      ) {
        if (
          this.ackedChunks.has(idx) ||
          this.packetCache.has(idx) ||
          this.prefetchInProgress.has(idx)
        ) continue;

        this.prefetchInProgress.add(idx);
        scheduled++;

        tasks.push(
          this.buildPacket(idx).then(packet => {
            this.prefetchInProgress.delete(idx);
            if (packet) this.packetCache.set(idx, packet);
          }).catch(err => {
            // Always remove from in-progress on failure so the chunk can be retried.
            // Without this, a buildPacket rejection leaves the index permanently in
            // prefetchInProgress and the pump never re-schedules it.
            this.prefetchInProgress.delete(idx);
            console.warn(`[TransferEngine] buildPacket(${idx}) failed (will retry):`, err);
          })
        );
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    } finally {
      this.isPrefetching = false;
      // KEY FIX: if the pump exited because isPrefetching was true when it called
      // prefetchBatch (fire-and-forget race), it broke out with inFlight=0 and
      // nothing will call pumpWindow again. Restart it here.
      if (this.isSending && !this.isCanceled && !this.isPumping && !this.backpressurePaused) {
        this.pumpWindow();
      }
    }
  }

  private async buildPacket(index: number): Promise<ArrayBuffer | null> {
    if (!this.file || this.isCanceled) return null;

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.file.size);
    const arrayBuffer = await this.file.slice(start, end).arrayBuffer();
    let payload = new Uint8Array(arrayBuffer);
    const originalLength = payload.length;
    let flags = 0;

    if (this.isCompressible) {
      const compressed = LZ4.compress(payload);
      if (compressed.length < payload.length) {
        payload = new Uint8Array(compressed);
        flags |= 0x01;
      }
    }

    const xxhash64 = await this.hashPayload(payload);

    const packet = new Uint8Array(HEADER_SIZE + payload.length);
    const view = new DataView(packet.buffer);
    view.setUint32(0, index, true);
    view.setBigUint64(4, xxhash64, true);
    view.setUint8(12, flags);
    view.setUint32(13, originalLength, true);
    packet.set(payload, HEADER_SIZE);

    return packet.buffer;
  }

  // BUG 13 FIX: Only select from open channels in round-robin. Break if none open.
  private async pumpWindow() {
    if (this.isPumping || !this.isSending || !this.file) return;
    if (this.backpressurePaused) return;

    this.isPumping = true;
    let iterations = 0;
    try {
      while (
        this.inFlight.size < this.currentWindowSize &&
        this.nextChunkIndex < this.totalChunks &&
        !this.isCanceled &&
        !this.backpressurePaused
      ) {
        const chunkIndex = this.nextChunkIndex;

        if (this.ackedChunks.has(chunkIndex)) {
          this.nextChunkIndex++;
          continue;
        }

        if (!this.packetCache.has(chunkIndex)) {
          await this.prefetchBatch();
          if (!this.packetCache.has(chunkIndex)) break;
        }

        const packet = this.packetCache.get(chunkIndex)!;
        this.packetCache.delete(chunkIndex);

        if (this.packetCache.size > PACKET_CACHE_MAX) {
          const firstKey = this.packetCache.keys().next().value;
          if (firstKey !== undefined) this.packetCache.delete(firstKey);
        }
        this.nextChunkIndex++;

        if (iterations++ % 16 === 0) {
          // BUG 1 FIX: read bufferedAmount directly on the raw RTCDataChannel
          const totalBuffered = this.connections.reduce(
            (sum, c) => sum + (c?.bufferedAmount ?? 0), 0
          );
          if (totalBuffered > this.dynamicBackpressureHigh) {
            this.packetCache.set(chunkIndex, packet);
            this.nextChunkIndex--;
            this.backpressurePaused = true;
            this.backpressurePausedSince = Date.now();
            break;
          }
        }

        // BUG 13 FIX: dynamically filter to only open channels
        const openConns = this.connections.filter(c => c && c.readyState === 'open');
        if (openConns.length === 0) {
          // BUG 4 FIX: guard send — put packet back and stop
          this.packetCache.set(chunkIndex, packet);
          this.nextChunkIndex--;
          break;
        }

        const conn = openConns[this.nextConnIdx++ % openConns.length];

        // BUG 4 FIX: explicit readyState guard before send
        if (!conn || conn.readyState !== 'open') {
          this.packetCache.set(chunkIndex, packet);
          this.nextChunkIndex--;
          break;
        }

        if (chunkIndex < TransferEngine.RTT_SAMPLE_COUNT && this.networkProfile === 'unknown') {
          this.rttProbeStartTimes.set(chunkIndex, performance.now());
        }

        try {
          conn.send(packet);
        } catch (sendErr) {
          // Browser buffer full — put packet back, pause, and let watchdog or bufferedamountlow resume.
          console.warn('[TransferEngine] send() threw — buffer full, pausing pump');
          this.packetCache.set(chunkIndex, packet);
          this.nextChunkIndex--;
          this.backpressurePaused = true;
          this.backpressurePausedSince = Date.now();
          break;
        }

        this.inFlight.add(chunkIndex);
        const view = new DataView(packet);
        this.bytesTransferred += view.getUint32(13, true);

        if (this.packetCache.size < PREFETCH_BATCH / 2) {
          this.prefetchBatch();
        }
      }

      if (this.ackedChunks.size === this.totalChunks) {
        this.finishTransfer();
      }
    } finally {
      this.isPumping = false;
    }
  }

  public processAck(index: number) {
    this.inFlight.delete(index);
    this.ackedChunks.add(index);
    this.lastAckReceivedAt = Date.now();

    if (this.networkProfile === 'unknown' && this.rttProbeStartTimes.has(index)) {
      const rtt = performance.now() - this.rttProbeStartTimes.get(index)!;
      this.rttProbeStartTimes.delete(index);
      this.rttSamples.push(rtt);

      if (this.rttSamples.length >= TransferEngine.RTT_SAMPLE_COUNT) {
        const avgRtt = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
        this.networkProfile = avgRtt <= TransferEngine.RTT_LAN_THRESHOLD_MS ? 'lan' : 'wifi';
        this.activeProfile = this.networkProfile === 'lan'
          ? TransferEngine.PROFILE_LAN
          : TransferEngine.PROFILE_WIFI;

        // BUG: window jump fixed — DO NOT use windowFloor here (PROFILE_LAN floor=1024 would
        // immediately blast 128 MB into the channel from a cold start of 16-32 chunks,
        // causing WebRTC buffer overrun and a permanent stall). Instead, preserve the
        // current window and only clamp it down to the new ceiling.
        this.currentWindowSize = Math.max(
          16, // absolute safety floor — never below 2 MB in-flight
          Math.min(this.currentWindowSize, this.activeProfile.windowCeiling)
        );
        this.slowStartThreshold = this.activeProfile.slowStartThreshold;

        // BUG 10 FIX: call conn.close() directly, not conn.dataChannel?.close()
        if (!this.activeProfile.useMultiChannel && this.connections.length > 1) {
          const primary = this.connections[0];
          this.connections.slice(1).forEach(conn => {
            try { conn.close(); } catch (_) {}
          });
          this.connections = [primary];
        }

        // Cap window growth to protect slower receivers (phone CPU, mobile WebRTC stack)
        // True ceiling is enforced by AIMD — the window only grows if ACKs keep arriving.
        if (this.networkProfile === 'lan') {
          this.activeProfile = {
            ...TransferEngine.PROFILE_LAN,
            windowFloor: 16,    // match absolute floor so shrinkWindow doesn't conflict
            windowCeiling: 512, // allow up to 512 chunks (64 MB) — LAN can sustain it via backpressure
          };
          // Re-clamp in case the new ceiling differs from PROFILE_LAN's
          this.currentWindowSize = Math.min(this.currentWindowSize, 512);
        }

        this.updateDynamicBackpressure();
        this.tuneSocketBuffers();

        console.log(`[TransferEngine] Network profile: ${this.networkProfile}, avg RTT: ${avgRtt.toFixed(2)}ms`);
      }
    }

    if (this.isSending && !this.backpressurePaused) {
      if (this.slowStartActive) {
        this.acksSinceGrow++;
        if (this.acksSinceGrow >= this.currentWindowSize) {
          this.currentWindowSize = Math.min(
            this.currentWindowSize * 2,
            this.slowStartThreshold,
            this.activeProfile.windowCeiling  // never overshoot ceiling during slow-start
          );
          this.acksSinceGrow = 0;
          if (this.currentWindowSize >= this.slowStartThreshold) {
            this.slowStartActive = false;
          }
        }
        this.updateDynamicBackpressure();
      } else {
        this.growWindow();
      }
    }

    // BUG 1 FIX: read bufferedAmount directly on raw RTCDataChannel
    if (this.backpressurePaused) {
      const total = this.connections.reduce(
        (sum, c) => sum + (c?.bufferedAmount ?? 0), 0
      );
      // Clear pause if buffer is drained OR if all in-flight chunks are now ACKed.
      // The second condition handles Android Chrome returning stale bufferedAmount
      // readings under CPU load (hotspot routing + sending simultaneously).
      if (total <= this.activeProfile.backpressureLowBytes || this.inFlight.size === 0) {
        this.backpressurePaused = false;
        this.backpressurePausedSince = 0;
      }

      if (
        this.backpressurePaused &&
        this.backpressurePausedSince > 0 &&
        Date.now() - this.backpressurePausedSince > STALE_PAUSE_TIMEOUT_MS
      ) {
        if (total < this.activeProfile.backpressureLowBytes) {
          console.warn('[TransferEngine] Stale pause cleared in processAck');
          this.backpressurePaused = false;
          this.backpressurePausedSince = 0;
        }
        // NOTE: do NOT reset backpressurePausedSince here.
        // Resetting the clock on every ACK was the deadlock — it prevented the
        // setInterval watchdog's 3000ms hard-timeout from ever accumulating.
      }

    }

    this.pumpWindow();
  }

  public processNack(index: number) {
    this.inFlight.delete(index);
    this.retransmits++;
    this.packetCache.delete(index);
    this.prefetchInProgress.delete(index);
    // BUG 4 FIX: guard readyState before calling send
    this.buildPacket(index).then(packet => {
      if (!packet || this.isCanceled) return;
      const conn = this.connections[this.nextConnIdx++ % this.connections.length];
      if (!conn || conn.readyState !== 'open') return;
      conn.send(packet);
      this.inFlight.add(index);
    });
  }

  // ─── Receiver: Public API ────────────────────────────────────────────────
  public setStreamWriter(writer: FileSystemWritableFileStream | null) {
    this.streamWriter = writer;
  }

  public async closeStreamWriterAsync(): Promise<void> {
    if (this.streamWriter) {
      const writer = this.streamWriter;
      this.streamWriter = null;
      try {
        const closePromise = (async () => {
          try {
            if (typeof (writer as any).abort === 'function') {
              await (writer as any).abort();
            } else if (typeof writer.close === 'function') {
              await writer.close();
            }
          } catch (err) {
            console.warn('[TransferEngine] stream writer close/abort error:', err);
          }
        })();

        const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 300));
        await Promise.race([closePromise, timeoutPromise]);
      } catch (err) {
        console.warn('[TransferEngine] closeStreamWriterAsync failed:', err);
      }
    }
  }

  public initReceiver(meta: FileMetadata) {
    this.isCanceled = false;
    const cleanName = sanitizeFilename(meta.name);
    const validSize = (typeof meta.size === 'number' && Number.isFinite(meta.size) && meta.size >= 0 && meta.size <= 100 * 1024 * 1024 * 1024)
      ? meta.size
      : 0;
    const maxChunks = 2_000_000;
    const expectedChunks = validSize > 0 ? Math.ceil(validSize / CHUNK_SIZE) : 0;
    const totalChunks = (typeof meta.totalChunks === 'number' && Number.isFinite(meta.totalChunks) && meta.totalChunks >= 0 && meta.totalChunks <= maxChunks)
      ? meta.totalChunks
      : expectedChunks;

    this.fileMeta = {
      ...meta,
      name: cleanName,
      size: validSize,
      totalChunks: totalChunks,
      chunkSize: meta.chunkSize || CHUNK_SIZE,
    };

    this.receivedChunks.clear();
    this.startTime = performance.now();
    this.bytesTransferred = 0;
    try {
      this.receiveChunksArray = new Array(totalChunks);
    } catch (err) {
      console.error('[TransferEngine] RangeError or allocation error initializing receiveChunksArray:', err);
      this.receiveChunksArray = [];
      if (this.onComplete) this.onComplete(null);
      return;
    }
    this.receiveQueue = [];
    this.isProcessingQueue = false;
    this.lastFlushedIndex = -1;
    this.partialBlobs = [];
    this.streamWriter = null;
    this.startTelemetry();
    this.startRamWatchdog();

    if (totalChunks === 0) this.finishReceive();
  }

  private startRamWatchdog(): void {
    if (!('memory' in performance)) return;

    this.ramWatchdogInterval = setInterval(() => {
      const usedMB = (performance as any).memory.usedJSHeapSize / (1024 * 1024);

      if (usedMB > TransferEngine.RAM_FLUSH_MB && !this.streamWriter) {
        console.warn(`[TransferEngine] RAM at ${usedMB.toFixed(0)} MB — emergency flush`);
        this.emergencyFlushReceiveBuffer();
      } else if (usedMB > TransferEngine.RAM_WARN_MB) {
        console.warn(`[TransferEngine] RAM at ${usedMB.toFixed(0)} MB — approaching limit`);
      }
    }, 5000);
  }

  private emergencyFlushReceiveBuffer(): void {
    if (this.receiveChunksArray.length === 0) return;

    let contiguousEnd = this.lastFlushedIndex;
    while (contiguousEnd + 1 < this.fileMeta!.totalChunks && this.receiveChunksArray[contiguousEnd + 1] != null) {
      contiguousEnd++;
    }

    if (contiguousEnd > this.lastFlushedIndex) {
      const chunksToFlush = this.receiveChunksArray.slice(this.lastFlushedIndex + 1, contiguousEnd + 1);
      const partialBlob = new Blob(chunksToFlush);
      this.partialBlobs.push(partialBlob);
      
      for (let i = this.lastFlushedIndex + 1; i <= contiguousEnd; i++) {
        (this.receiveChunksArray as any)[i] = null;
      }
      this.lastFlushedIndex = contiguousEnd;
      console.log(`[TransferEngine] Flushed chunks up to ${contiguousEnd} to partial blob`);
    } else {
      console.warn('[TransferEngine] Cannot flush: no contiguous chunks available at the start');
    }
  }

  // U2 (R4): can the receiver still produce every chunk its manifest claims?
  // Conjunction, not a choice:
  //  - fileMeta is non-null (an initialized receiver),
  //  - every chunk in receivedChunks ABOVE lastFlushedIndex is still non-null in
  //    receiveChunksArray — those live only in RAM,
  //  - either nothing has been flushed yet (lastFlushedIndex < 0) or the stream
  //    writer is still live, because flushed chunks were nulled out of RAM and
  //    exist only on disk.
  public canProduceManifest(): boolean {
    if (!this.fileMeta) return false;
    for (let i = this.lastFlushedIndex + 1; i < this.fileMeta.totalChunks; i++) {
      if (this.receivedChunks.has(i) && this.receiveChunksArray[i] == null) {
        return false;
      }
    }
    if (this.lastFlushedIndex >= 0 && !this.streamWriter) return false;
    return true;
  }

  public getReceivedManifest(): number[] {
    if (!this.canProduceManifest()) return [];
    return Array.from(this.receivedChunks);
  }

  public enqueueChunk(buffer: ArrayBuffer) {
    if (this.isCanceled || !this.fileMeta) return;
    this.receiveQueue.push(buffer);
    if (!this.isProcessingQueue) {
      this.drainReceiveQueue();
    }
  }

  private async drainReceiveQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.receiveQueue.length > 0 && !this.isCanceled) {
      const buffer = this.receiveQueue.shift()!;
      try {
        await this.processChunkInternal(buffer);
      } catch (err) {
        console.error('[TransferEngine] Error processing chunk:', err);
      }
    }

    this.isProcessingQueue = false;
  }

  private async processChunkInternal(buffer: ArrayBuffer) {
    if (this.isCanceled || !this.fileMeta) return;
    if (buffer.byteLength < HEADER_SIZE) {
      console.warn('[TransferEngine] Malformed chunk buffer: smaller than HEADER_SIZE');
      return;
    }

    if (this.receivedChunks.size === 0) {
      this.startTime = performance.now();
    }

    const packet = new Uint8Array(buffer);
    const view = new DataView(buffer);

    const index = view.getUint32(0, true);
    if (index >= this.fileMeta.totalChunks) {
      console.warn(`[TransferEngine] Chunk index ${index} out of bounds (totalChunks: ${this.fileMeta.totalChunks}), dropping`);
      return;
    }
    const flags = view.getUint8(12);
    const originalLength = view.getUint32(13, true);
    if (originalLength > CHUNK_SIZE * 4) {
      console.warn(`[TransferEngine] Oversized originalLength ${originalLength}, dropping chunk ${index}`);
      return;
    }
    let payload = packet.slice(HEADER_SIZE);

    if (this.receivedChunks.has(index)) return;

    if ((flags & 0x01) !== 0) {
      try {
        payload = new Uint8Array(LZ4.decompress(payload));
      } catch {
        this.sendNack(index);
        return;
      }
    }

    const cleanBuffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength
    );

    this.receiveChunksArray[index] = cleanBuffer;
    this.receivedChunks.add(index);
    this.bytesTransferred += originalLength;

    // ACK BEFORE disk I/O: decouples disk write latency from the ACK path.
    // On hotspot/LAN the sender fills its inFlight window in milliseconds.
    // If we wait for await flushWriteBuffer() before ACKing, the sender's
    // staleWatchdog (3s no-ACK hard timeout) fires, clears inFlight, and
    // blasts a new burst — creating an oscillation that permanently stalls.
    // SCTP CRC32c guarantees the data is already safe in receiveChunksArray;
    // the ACK just tells the sender the slot is consumable.
    this.sendAck(index);

    if (this.streamWriter) {
      // flushWriteBuffer is now fire-and-forget from the ACK perspective.
      // We still await it here so the queue drain stays sequential and we
      // don't open multiple parallel writes to the same file handle.
      await this.flushWriteBuffer();
    }

    if (this.receivedChunks.size === this.fileMeta!.totalChunks) {
      if (this.streamWriter) {
        await this.flushWriteBuffer(true);
      }
      await this.finishReceive();
    }
  }

  private async flushWriteBuffer(force = false) {
    if (!this.streamWriter || !this.fileMeta) return;
    
    let contiguousEnd = this.lastFlushedIndex;
    let batchBytes = 0;
    while (contiguousEnd + 1 < this.fileMeta.totalChunks && this.receiveChunksArray[contiguousEnd + 1] != null) {
      batchBytes += this.receiveChunksArray[contiguousEnd + 1].byteLength;
      contiguousEnd++;
    }

    if (contiguousEnd > this.lastFlushedIndex) {
      if (force || batchBytes >= TransferEngine.WRITE_BATCH_BYTES || contiguousEnd === this.fileMeta.totalChunks - 1) {
        const chunksToFlush = this.receiveChunksArray.slice(this.lastFlushedIndex + 1, contiguousEnd + 1);
        const combined = new Blob(chunksToFlush);
        const buf = await combined.arrayBuffer();
        
        const byteOffset = (this.lastFlushedIndex + 1) * this.fileMeta.chunkSize;
        
        try {
          await (this.streamWriter as any).write({
            type: 'write',
            position: byteOffset,
            data: buf,
          });
          
          for (let i = this.lastFlushedIndex + 1; i <= contiguousEnd; i++) {
            (this.receiveChunksArray as any)[i] = null;
          }
          this.lastFlushedIndex = contiguousEnd;
        } catch (writeErr) {
          console.warn(`[Stream] Batch write failed, falling back to RAM:`, writeErr);
          this.streamWriter = null;
        }
      }
    }
  }

  // BUG 2 FIX: Use conn.readyState === 'open' instead of the non-existent conn.open property.
  // Also added early-return guard if controlConnections is empty.
  // CHANGE 1: Batched ACKs — accumulate and flush every 50ms or every 32 ACKs.
  private sendAck(index: number) {
    if (this.controlConnections.length === 0) return;
    this.pendingAcks.push(index);

    if (this.pendingAcks.length >= TransferEngine.ACK_FLUSH_COUNT) {
      // Batch is full — flush immediately
      if (this.ackFlushTimer !== null) {
        clearTimeout(this.ackFlushTimer);
        this.ackFlushTimer = null;
      }
      this.flushAcks();
      return;
    }

    if (this.ackFlushTimer === null) {
      this.ackFlushTimer = setTimeout(() => {
        this.ackFlushTimer = null;
        this.flushAcks();
      }, TransferEngine.ACK_FLUSH_INTERVAL_MS);
    }
  }

  private flushAcks() {
    if (this.pendingAcks.length === 0) return;
    if (this.controlConnections.length === 0) { this.pendingAcks = []; return; }

    // Send one binary message containing all pending ACK indices packed as 5-byte entries
    // Format: type byte 0x02 + 4-byte LE chunk index, repeated
    const count = this.pendingAcks.length;
    const buf = new ArrayBuffer(5 * count);
    const v = new DataView(buf);
    for (let i = 0; i < count; i++) {
      v.setUint8(i * 5, 0x02);
      v.setUint32(i * 5 + 1, this.pendingAcks[i], true);
    }
    this.pendingAcks = [];

    const conn = this.controlConnections[this.nextCtrlIdx++ % this.controlConnections.length];
    if (conn && conn.readyState === 'open') conn.send(buf);
  }

  private sendNack(index: number) {
    if (this.controlConnections.length === 0) return;
    const buf = new ArrayBuffer(5);
    const v = new DataView(buf);
    v.setUint8(0, 0x03);
    v.setUint32(1, index, true);
    const conn = this.controlConnections[this.nextCtrlIdx++ % this.controlConnections.length];
    if (conn && conn.readyState === 'open') conn.send(buf);
  }

  private async finishReceive() {
    this.stopTelemetry();
    if (!this.fileMeta) { this.receiveChunksArray = []; return; }

    if (this.streamWriter) {
      try {
        await this.streamWriter.close();
        console.log('[Stream] File written to disk successfully.');
      } catch (e) {
        console.warn('[Stream] stream.close() error:', e);
      }
      this.streamWriter = null;
      if (this.onComplete) this.onComplete(null);
    } else {
      const remaining = this.receiveChunksArray.slice(this.lastFlushedIndex + 1);
      if (remaining.some(b => b == null)) {
        console.error("[Stream] Missing chunks in final assembly! File may be corrupted.");
      }
      const finalParts = [
        ...this.partialBlobs,
        ...remaining
      ];
      const blob = new Blob(finalParts, { type: this.fileMeta.type });

      this.partialBlobs = [];
      for (let i = 0; i < this.receiveChunksArray.length; i++) {
        (this.receiveChunksArray as any)[i] = null;
      }
      this.receiveChunksArray = [];

      if (this.onComplete) this.onComplete(blob);
    }
  }

  private finishTransfer() {
    this.isSending = false;
    this.stopTelemetry();
    if (this.onComplete) this.onComplete();
  }

  private startTelemetry() {
    if (this.telemetryInterval) clearInterval(this.telemetryInterval);
    this.telemetryInterval = setInterval(() => {
      if (this.isCanceled || !this.onTelemetryUpdate) return;

      const now = performance.now();
      const delta = this.bytesTransferred - this.lastBytesForSpeed;
      this.lastBytesForSpeed = this.bytesTransferred;
      this.speedSamples.push({ time: now, bytes: delta });

      const cutoff = now - 8000;
      this.speedSamples = this.speedSamples.filter(s => s.time >= cutoff);

      const windowBytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
      const windowSec = Math.min((now - this.startTime) / 1000, 8);
      const speedBps = windowSec > 0 ? windowBytes / windowSec : 0;
      const speedMBps = speedBps / (1024 * 1024);

      const totalSize = this.file
        ? this.file.size
        : (this.fileMeta?.size ?? 0);
      const etaSeconds = speedBps > 0 ? (totalSize - this.bytesTransferred) / speedBps : 0;

      const totalChunks = this.file
        ? this.totalChunks
        : (this.fileMeta?.totalChunks ?? 0);
      const chunksDone = this.file
        ? this.ackedChunks.size
        : this.receivedChunks.size;
      const progress = totalChunks > 0
        ? Math.round((chunksDone / totalChunks) * 100)
        : 0;

      this.onTelemetryUpdate({
        speedMBps,
        etaSeconds,
        chunksSent: chunksDone,
        totalChunks,
        retransmits: this.retransmits,
        inFlight: this.inFlight.size,
        progress,
        windowSize: this.currentWindowSize,
      });
    }, 1000);
  }

  private stopTelemetry() {
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }

  public destroy(): void {
    if (this.ackFlushTimer !== null) { clearTimeout(this.ackFlushTimer); this.ackFlushTimer = null; }
    this.pendingAcks = [];
    this.isSending = false;
    this.isCanceled = true;
    this.backpressurePaused = false;
    this.stopTelemetry();

    if (this.ramWatchdogInterval) {
      clearInterval(this.ramWatchdogInterval);
      this.ramWatchdogInterval = null;
    }

    if (this.staleWatchdogInterval) {
      clearInterval(this.staleWatchdogInterval);
      this.staleWatchdogInterval = null;
    }

    this.packetCache.clear();
    this.inFlight.clear();
    this.rttProbeStartTimes.clear();
    this.rttSamples = [];

    this.hasherWorkers?.forEach(worker => worker.terminate());
    this.hasherWorkers = [];

    if (this.streamWriter) {
      const writer = this.streamWriter;
      this.streamWriter = null;
      try {
        if (typeof (writer as any).abort === 'function') {
          (writer as any).abort().catch(() => {});
        } else if (typeof writer.close === 'function') {
          writer.close().catch(() => {});
        }
      } catch (_) {}
    }

    // Close all DataChannels — raw RTCDataChannel objects
    this.connections.forEach(conn => {
      try { if (conn && typeof conn.close === 'function') conn.close(); } catch (_) {}
    });
    this.connections = [];

    this.controlConnections.forEach(conn => {
      try { if (conn && typeof conn.close === 'function') conn.close(); } catch (_) {}
    });
    this.controlConnections = [];

    for (let i = 0; i < this.receiveChunksArray.length; i++) {
      (this.receiveChunksArray as any)[i] = null;
    }
    this.receiveChunksArray = [];
    this.partialBlobs = [];
    this.receiveQueue = [];

    this.hasherCallbacks.clear();

    this.file = null;
    this.fileMeta = null;
    this.networkProfile = 'unknown';
    this.activeProfile = TransferEngine.PROFILE_LAN;

    console.log('[TransferEngine] Destroyed — all buffers and workers released');
  }

  public resetForNextFile(newConns: RTCDataChannel[], newControlConns: RTCDataChannel[]) {
    this.stopTelemetry();
    if (this.ramWatchdogInterval) {
      clearInterval(this.ramWatchdogInterval);
      this.ramWatchdogInterval = null;
    }

    if (this.staleWatchdogInterval) {
      clearInterval(this.staleWatchdogInterval);
      this.staleWatchdogInterval = null;
    }
    if (this.streamWriter) {
      const writer = this.streamWriter;
      this.streamWriter = null;
      try {
        if (typeof (writer as any).abort === 'function') {
          (writer as any).abort().catch(() => {});
        } else if (typeof writer.close === 'function') {
          writer.close().catch(() => {});
        }
      } catch (_) {}
    }
    this.isCanceled = false;
    this.isSending = false;
    this.file = null;
    this.fileMeta = null;
    this.totalChunks = 0;
    this.nextChunkIndex = 0;
    this.inFlight.clear();
    this.ackedChunks.clear();
    this.retransmits = 0;
    this.nextConnIdx = 0;
    this.nextCtrlIdx = 0;
    this.backpressurePaused = false;
    this.isPumping = false;
    this.packetCache.clear();
    this.prefetchInProgress.clear();
    this.bytesTransferred = 0;
    this.lastBytesForSpeed = 0;
    this.speedSamples = [];
    for (let i = 0; i < this.receiveChunksArray.length; i++) {
      (this.receiveChunksArray as any)[i] = null;
    }
    this.receiveChunksArray = [];
    this.receiveQueue = [];
    this.receivedChunks.clear();
    this.isProcessingQueue = false;
    this.connections = newConns;
    this.controlConnections = newControlConns;
    this.tuneSocketBuffers();
  }

  public cleanup() {
    if (this.ackFlushTimer !== null) { clearTimeout(this.ackFlushTimer); this.ackFlushTimer = null; }
    this.pendingAcks = [];
    this.stopTelemetry();
    this.isSending = false;
    if (this.streamWriter) {
      const writer = this.streamWriter;
      this.streamWriter = null;
      try {
        if (typeof (writer as any).abort === 'function') {
          (writer as any).abort().catch(() => {});
        } else if (typeof writer.close === 'function') {
          writer.close().catch(() => {});
        }
      } catch (_) {}
    }
    for (let i = 0; i < this.receiveChunksArray.length; i++) {
      (this.receiveChunksArray as any)[i] = null;
    }
    this.receiveChunksArray = [];
    this.receiveQueue = [];
    this.packetCache.clear();
    this.prefetchInProgress.clear();
    this.file = null;
    this.speedSamples = [];
    this.lastBytesForSpeed = 0;
    this.hasherCallbacks.clear();

    if (this.ramWatchdogInterval) {
      clearInterval(this.ramWatchdogInterval);
      this.ramWatchdogInterval = null;
    }

    if (this.staleWatchdogInterval) {
      clearInterval(this.staleWatchdogInterval);
      this.staleWatchdogInterval = null;
    }
  }

  public cancel() {
    if (this.ackFlushTimer !== null) { clearTimeout(this.ackFlushTimer); this.ackFlushTimer = null; }
    this.pendingAcks = [];
    this.isCanceled = true;
    this.cleanup();
    this.inFlight.clear();
    this.ackedChunks.clear();
    this.receivedChunks.clear();
    this.bytesTransferred = 0;
    this.speedSamples = [];
    this.lastBytesForSpeed = 0;
    this.retransmits = 0;
    this.nextChunkIndex = 0;
    this.totalChunks = 0;
    this.fileMeta = null;
  }
}
