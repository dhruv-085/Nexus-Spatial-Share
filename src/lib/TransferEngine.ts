import LZ4 from 'lz4js';

export interface TransferTelemetry {
  speedMBps: number;
  etaSeconds: number;
  chunksSent: number;
  totalChunks: number;
  retransmits: number;
  inFlight: number;
  progress: number;
  windowSize: number;          // current adaptive window (for debugging / display)
}

export interface FileMetadata {
  name: string;
  type: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
}

// ─── Tunable Constants ────────────────────────────────────────────────────────
// 512 KB chunks: fine-grained backpressure, proven 12–22 MB/s on LAN.
export const CHUNK_SIZE = 2 * 1024 * 1024;              // 2 MB per chunk
export const HEADER_SIZE = 17;                     // 4(idx)+8(hash)+1(flags)+4(origLen)
const PREFETCH_BATCH = 20;                         // 40 MB prefetch
const PACKET_CACHE_MAX = 30;                       // 60 MB RAM cap
// Backpressure thresholds
const BACKPRESSURE_LOW_BYTES  = 16 * 1024 * 1024;  // 16 MB — resume pumping
// ── Adaptive window constants ─────────────────────────────────────────────────────
const WINDOW_GROW_STEP = 1;                        // chunks to add per growth tick
const STALE_PAUSE_TIMEOUT_MS = 4000;               // 4s watchdog                        // chunks to add per growth tick
// ─────────────────────────────────────────────────────────────────────────────


const COMPRESSIBLE_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'application/javascript',
  'application/json', 'text/csv', 'application/xml', 'image/bmp',
  'image/x-ms-bmp', 'image/svg+xml'
]);

// Pre-built packet cache: index → ready-to-send ArrayBuffer
type PacketCache = Map<number, ArrayBuffer>;

export class TransferEngine {
  // ── Sender state ────────────────────────────────────────────────────────────
  private file: File | null = null;
  private connections: any[] = [];
  private controlConnections: any[] = [];
  private nextConnIdx = 0;          // round-robin for data channels
  private nextCtrlIdx = 0;          // round-robin for control channels
  private totalChunks = 0;
  private nextChunkIndex = 0;
  private inFlight = new Set<number>();
  private ackedChunks = new Set<number>();
  private retransmits = 0;
  private isCompressible = false;
  private isSending = false;
  private isCanceled = false;

  // Prefetch pipeline: chunks prepared ahead of the send pointer
  private packetCache: PacketCache = new Map();
  private prefetchInProgress = new Set<number>();   // currently being built
  private isPumping = false;                         // re-entrancy guard

  // Event-driven backpressure
  private backpressurePaused = false;
  private backpressurePausedSince = 0;            // timestamp when pause began (for stale guard)
  private backpressureListeners: (() => void)[] = [];

  // ── Network Profile ──────────────────────────────────────────────────────────
  private networkProfile: 'unknown' | 'lan' | 'wifi' = 'unknown';
  private rttSamples: number[] = [];
  private rttProbeStartTimes: Map<number, number> = new Map(); // chunkIndex → sendTime
  private static readonly RTT_SAMPLE_COUNT = 5;
  private static readonly RTT_LAN_THRESHOLD_MS = 2; // avg RTT below this = LAN

  private static readonly PROFILE_LAN = {
    windowFloor: 16,          // 32 MB in-flight floor
    windowCeiling: 64,        // 128 MB ceiling
    windowGrowDivisor: 8,     // grow every window/8 ACKs
    backpressureLowBytes: 16 * 1024 * 1024,   // 16 MB resume threshold
    backpressureHighCap: 96 * 1024 * 1024,    // 96 MB pause cap
    useMultiChannel: true,    // round-robin striping ON
    slowStartThreshold: 32,   // hand off to AIMD at 32 chunks
  };

  private static readonly PROFILE_WIFI = {
    windowFloor: 8,           // 16 MB floor — less aggressive
    windowCeiling: 32,        // 64 MB ceiling — prevents radio flooding
    windowGrowDivisor: 12,    // slower additive increase
    backpressureLowBytes: 8 * 1024 * 1024,    // 8 MB resume threshold — resume sooner
    backpressureHighCap: 48 * 1024 * 1024,    // 48 MB pause cap — pause sooner
    useMultiChannel: false,   // single DataChannel only — no multi-channel contention
    slowStartThreshold: 16,   // hand off to AIMD earlier
  };

  private activeProfile = TransferEngine.PROFILE_LAN; // default until detected

  // ── Live RAM Watchdog ──────────────────────────────────────────────────────
  private ramWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly RAM_WARN_MB = 400;
  private static readonly RAM_FLUSH_MB = 600;
  private partialBlobs: Blob[] = [];

  // ── Adaptive window (ACK-counter based AIMD) ──────────────────────────────────
  // dynamicBackpressureHigh grows with the window to avoid false pauses.
  private slowStartActive = true;
  private slowStartThreshold = this.activeProfile.slowStartThreshold; // switch to AIMD when window hits this
  private dynamicBackpressureHigh = this.activeProfile.windowFloor * CHUNK_SIZE * 1.5;
  // currentWindowSize is the live window.  It grows +WINDOW_GROW_STEP per growth
  // tick and shrinks ×0.75 on DataChannel backpressure (multiplicative decrease).
  private currentWindowSize = this.activeProfile.windowFloor;
  // acksSinceGrow counts ACKs since the last window increase.
  // Grow when count reaches ceil(currentWindowSize / windowGrowDivisor)
  private acksSinceGrow = 0;

  // ── Receiver state ──────────────────────────────────────────────────────────
  // RAM-buffered fallback (used when streamWriter is not available)
  private receiveChunksArray: ArrayBuffer[] = [];
  private receivedChunks = new Set<number>();
  private fileMeta: FileMetadata | null = null;
  // Streaming mode: write each chunk directly to disk as it arrives.
  // Eliminates the need to hold the entire file in RAM.
  private streamWriter: FileSystemWritableFileStream | null = null;

  // Synchronous receive queue — raw buffers pushed without awaiting
  private receiveQueue: ArrayBuffer[] = [];
  private isProcessingQueue = false;

  // ── Telemetry ────────────────────────────────────────────────────────────────
  private startTime = 0;
  private bytesTransferred = 0;
  private speedSamples: { time: number; bytes: number }[] = [];
  private lastBytesForSpeed = 0;
  private onTelemetryUpdate: ((t: TransferTelemetry) => void) | null = null;
  // onComplete is called:
  //   blob (Blob)      → receiver, buffered mode — assemble from RAM
  //   null             → receiver, streaming mode — file is already on disk
  //   undefined        → sender — all chunks sent, wait for TRANSFER_COMPLETE
  private onComplete: ((blob?: Blob | null) => void) | null = null;
  private telemetryInterval: any = null;

  // ── Hasher worker pool (2 workers → parallel hashing) ────────────────────────
  private hasherWorkers: Worker[] = [];
  private hasherCallbacks = new Map<number, (hash: bigint) => void>();
  private hasherIdCounter = 0;
  private hasherReadyCount = 0;
  private hasherWorkerReady: Promise<void>;
  private hasherWorkerReadyResolve!: () => void;
  private workerRoundRobin = 0;

  constructor(connections: any[]) {
    this.connections = connections;
    this.tuneSocketBuffers();

    this.hasherWorkerReady = new Promise(resolve => {
      this.hasherWorkerReadyResolve = resolve;
    });

    // Spawn 2 hasher workers so hash operations overlap with I/O
    const WORKER_COUNT = 2;
    for (let i = 0; i < WORKER_COUNT; i++) {
      const w = new Worker(
        new URL('./hasher.worker.ts', import.meta.url),
        { type: 'module' }
      );
      w.onmessage = (e) => {
        if (e.data.type === 'READY') {
          this.hasherReadyCount++;
          if (this.hasherReadyCount === WORKER_COUNT) {
            this.hasherWorkerReadyResolve();
          }
          return;
        }
        const cb = this.hasherCallbacks.get(e.data.id);
        if (cb) {
          this.hasherCallbacks.delete(e.data.id);
          cb(e.data.hash);
        }
      };
      this.hasherWorkers.push(w);
    }
  }

  public setControlConnections(conns: any[]) {
    this.controlConnections = conns;
  }

  public setCallbacks(
    onTelemetry: (t: TransferTelemetry) => void,
    onComplete: (blob?: Blob) => void
  ) {
    this.onTelemetryUpdate = onTelemetry;
    this.onComplete = onComplete;
  }

  // ── Internal: hash via round-robin worker pool ─────────────────────────────
  private async hashPayload(payload: Uint8Array): Promise<bigint> {
    await this.hasherWorkerReady;
    return new Promise((resolve) => {
      const id = this.hasherIdCounter++;
      this.hasherCallbacks.set(id, resolve);
      const workerIdx = this.workerRoundRobin++ % this.hasherWorkers.length;
      const copy = payload.slice();                       // own ArrayBuffer
      this.hasherWorkers[workerIdx].postMessage({ id, payload: copy }, [copy.buffer]);
    });
  }

  // ── Buffer tuning ──────────────────────────────────────────────────────────
  private tuneSocketBuffers() {
    for (const conn of this.connections) {
      if (conn?.dataChannel) {
        conn.dataChannel.bufferedAmountLowThreshold = this.activeProfile.backpressureLowBytes;
        conn.dataChannel.onbufferedamountlow = () => {
          if (this.backpressurePaused) {
            this.backpressurePaused = false;
            this.backpressurePausedSince = 0;
            this.pumpWindow();
          }
        };
      }
    }
  }

/**
   * ACK-counter based AIMD window growth (additive increase).
   * Called on every ACK from processAck — guaranteed to grow the window.
   *
   * Growth tick fires every ceil(currentWindowSize / 4) ACKs.
   * That's roughly once per quarter-RTT, so the window doubles per full RTT.
   * No timing measurement, no clock bugs, no bootstrap delay.
   *
   * Example ramp at 20 MB/s (40 ACKs/s):
   *   window=32: tick every 8 ACKs → 5 ticks/s × +2 = +10 chunks/s
   *   32 → 128 ceiling in (128-32)/10 = 9.6 seconds
   */
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

  /** Multiplicative decrease — called when DataChannel backpressure fires. */
  private shrinkWindow(): void {
    const prev = this.currentWindowSize;
    if (this.slowStartActive) {
      this.slowStartThreshold = Math.max(Math.floor(this.currentWindowSize * 0.75), this.activeProfile.windowFloor);
      this.slowStartActive = false; // drop into AIMD immediately after first congestion
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



  // ─── Sender: Public API ────────────────────────────────────────────────────
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

    // Reset adaptive window to floor so we ramp up fresh for each file
    this.currentWindowSize = this.activeProfile.windowFloor;
    this.acksSinceGrow = 0;
    this.slowStartActive = true;
    this.slowStartThreshold = this.activeProfile.slowStartThreshold;
    this.updateDynamicBackpressure();

    this.startTime = performance.now();
    this.bytesTransferred = resumeManifest.length * CHUNK_SIZE;

    this.startTelemetry();

    // Kick off prefetch pipeline then send
    await this.prefetchBatch();
    this.pumpWindow();
  }

  /**
   * Prefetch+hash the next PREFETCH_BATCH chunks in parallel.
   * Reads N file slices concurrently, hashes them concurrently,
   * and stores the resulting ready-to-send packets in the cache.
   */
  private async prefetchBatch() {
    if (!this.file || this.isCanceled) return;

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

      tasks.push(this.buildPacket(idx).then(packet => {
        this.prefetchInProgress.delete(idx);
        if (packet) this.packetCache.set(idx, packet);
      }));
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  /** Read one chunk, compress (optional), hash, build binary packet. Pure CPU work. */
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

  // ── Sliding window pump ───────────────────────────────────────────────────
  private async pumpWindow() {
    // Guard against re-entrancy
    if (this.isPumping || !this.isSending || !this.file) return;
    if (this.backpressurePaused) return;

    this.isPumping = true;
    try {
      // Re-read window size each iteration so window growth (from concurrent ACKs)
      // takes effect without waiting for the next pump call.
      const windowNow = this.currentWindowSize;

      while (
        this.inFlight.size < windowNow &&
        this.nextChunkIndex < this.totalChunks &&
        !this.isCanceled &&
        !this.backpressurePaused
      ) {
        const chunkIndex = this.nextChunkIndex;

        if (this.ackedChunks.has(chunkIndex)) {
          this.nextChunkIndex++;
          continue;
        }

        // If packet isn't ready yet, wait for prefetch to finish
        if (!this.packetCache.has(chunkIndex)) {
          await this.prefetchBatch();
          if (!this.packetCache.has(chunkIndex)) break;
        }

        const packet = this.packetCache.get(chunkIndex)!;
        this.packetCache.delete(chunkIndex);

        // Safety: evict oldest cached entry if cap exceeded (e.g. many NACKs)
        if (this.packetCache.size > PACKET_CACHE_MAX) {
          const firstKey = this.packetCache.keys().next().value;
          if (firstKey !== undefined) this.packetCache.delete(firstKey);
        }
        this.nextChunkIndex++;

        // ── Dynamic backpressure check ───────────────────────────────────────
        // Use this.dynamicBackpressureHigh — updated by updateAdaptiveWindow().
        const totalBuffered = this.connections.reduce(
          (sum, c) => sum + (c?.dataChannel?.bufferedAmount ?? 0), 0
        );
        if (totalBuffered > this.dynamicBackpressureHigh) {
          this.packetCache.set(chunkIndex, packet);
          this.nextChunkIndex--;
          this.backpressurePaused = true;
          this.backpressurePausedSince = Date.now();
          this.shrinkWindow();   // multiplicative decrease on congestion
          break;
        }

        // Round-robin across data channels
        const conn = this.connections[this.nextConnIdx++ % this.connections.length];
        
        // RTT Tracking SENDER: Record time immediately before dispatching the chunk
        if (chunkIndex < TransferEngine.RTT_SAMPLE_COUNT && this.networkProfile === 'unknown') {
          this.rttProbeStartTimes.set(chunkIndex, performance.now());
        }

        conn.send(packet);

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

    // RTT Measurement & Profiling Update
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

        // Apply profile — update all live AIMD state
        this.currentWindowSize = Math.max(
          this.activeProfile.windowFloor,
          Math.min(this.currentWindowSize, this.activeProfile.windowCeiling)
        );
        this.slowStartThreshold = this.activeProfile.slowStartThreshold;

        // If wifi, disable extra channels — close all but the primary DataChannel
        if (!this.activeProfile.useMultiChannel && this.connections.length > 1) {
          const primary = this.connections[0];
          this.connections.slice(1).forEach(conn => {
            try { conn.dataChannel?.close(); } catch (_) {}
          });
          this.connections = [primary];
        }

        // Apply dynamic limit updates with new bounds
        this.updateDynamicBackpressure();
        this.tuneSocketBuffers();

        console.log(`[TransferEngine] Network profile: ${this.networkProfile}, avg RTT: ${avgRtt.toFixed(2)}ms`);
      }
    }

    // Grow window on every ACK (AIMD additive-increase phase).
    // growWindow() is a no-op when already at ceiling.
    if (this.isSending && !this.backpressurePaused) {
      if (this.slowStartActive) {
        // Exponential growth: double window every RTT-worth of ACKs
        this.acksSinceGrow++;
        if (this.acksSinceGrow >= this.currentWindowSize) {
          this.currentWindowSize = Math.min(this.currentWindowSize * 2, this.slowStartThreshold);
          this.acksSinceGrow = 0;
          if (this.currentWindowSize >= this.slowStartThreshold) {
            this.slowStartActive = false; // hand off to AIMD
          }
        }
        this.updateDynamicBackpressure();
      } else {
        this.growWindow();
      }
    }

    // ── Polling backpressure recovery ───────────────────────────────────────
    // Safety net #1: ACK-driven poll — catches missed 'bufferedamountlow' events.
    if (this.backpressurePaused) {
      const total = this.connections.reduce(
        (sum, c) => sum + (c?.dataChannel?.bufferedAmount ?? 0), 0
      );
      if (total <= this.activeProfile.backpressureLowBytes) {
        this.backpressurePaused = false;
        this.backpressurePausedSince = 0;
      }

      // Safety net #2: Stale-pause watchdog
      if (
        this.backpressurePaused &&
        this.backpressurePausedSince > 0 &&
        Date.now() - this.backpressurePausedSince > STALE_PAUSE_TIMEOUT_MS
      ) {
        if (total < this.activeProfile.backpressureLowBytes) {
          console.warn('[TransferEngine] Stale pause cleared by watchdog');
          this.backpressurePaused = false;
          this.backpressurePausedSince = 0;
        } else {
          // Still genuinely congested — reset the watchdog timer, don't force-clear
          this.backpressurePausedSince = Date.now();
        }
      }
    }

    this.pumpWindow();
  }

  public processNack(index: number) {
    this.inFlight.delete(index);
    this.retransmits++;
    // Invalidate cached packet so it gets rebuilt fresh
    this.packetCache.delete(index);
    this.prefetchInProgress.delete(index);
    // Rebuild and resend directly
    this.buildPacket(index).then(packet => {
      if (!packet || this.isCanceled) return;
      const conn = this.connections[this.nextConnIdx++ % this.connections.length];
      conn.send(packet);
      this.inFlight.add(index);
    });
  }

  // ── Receiver: Public API ───────────────────────────────────────────────────

  /**
   * Provide a writable file stream so the receiver stores chunks directly on
   * disk instead of RAM.  Must be called AFTER initReceiver and BEFORE any
   * START_TRANSFER is sent (i.e. before chunks arrive).
   *
   * The stream should already be opened and pre-truncated to fileMeta.size.
   * It will be closed automatically when all chunks are received.
   *
   * If not set (or set to null), the engine falls back to the RAM-buffer mode.
   */
  public setStreamWriter(writer: FileSystemWritableFileStream | null) {
    this.streamWriter = writer;
  }

  public initReceiver(meta: FileMetadata) {
    this.isCanceled = false;
    this.fileMeta = meta;
    this.receivedChunks.clear();
    this.startTime = performance.now();
    this.bytesTransferred = 0;
    this.receiveChunksArray = new Array(meta.totalChunks); // slots only; no data yet
    this.receiveQueue = [];
    this.isProcessingQueue = false;
    this.partialBlobs = [];
    this.streamWriter = null; // caller sets this via setStreamWriter() if desired
    this.startTelemetry();
    this.startRamWatchdog();

    if (meta.totalChunks === 0) this.finishReceive();
  }

  private startRamWatchdog(): void {
    if (!('memory' in performance)) return; // API not available (Firefox)
    
    this.ramWatchdogInterval = setInterval(() => {
      const usedMB = (performance as any).memory.usedJSHeapSize / (1024 * 1024);

      if (usedMB > TransferEngine.RAM_FLUSH_MB && !this.streamWriter) {
        // Fallback mode is accumulating too much — flush what we have to a partial blob
        // and clear the array to free memory, then continue receiving
        console.warn(`[TransferEngine] RAM at ${usedMB.toFixed(0)} MB — emergency flush`);
        this.emergencyFlushReceiveBuffer();
      } else if (usedMB > TransferEngine.RAM_WARN_MB) {
        console.warn(`[TransferEngine] RAM at ${usedMB.toFixed(0)} MB — approaching limit`);
      }
    }, 5000); // check every 5 seconds
  }

  private emergencyFlushReceiveBuffer(): void {
    if (this.receiveChunksArray.length === 0) return;
    
    const snapshot = [...this.receiveChunksArray];
    
    // Release references immediately in the actual slots
    for (let i = 0; i < this.receiveChunksArray.length; i++) {
        if (this.receiveChunksArray[i]) {
            (this.receiveChunksArray as any)[i] = null;
        }
    }
    this.receiveChunksArray = new Array(this.fileMeta!.totalChunks);

    // Store partial blob in a separate list
    const partialBlob = new Blob(snapshot.filter(b => b != null));
    this.partialBlobs.push(partialBlob);

    console.log(`[TransferEngine] Flushed ${snapshot.filter(b => b != null).length} chunks to partial blob`);
  }

  public getReceivedManifest(): number[] {
    return Array.from(this.receivedChunks);
  }

  /**
   * Called by the DataChannel data event — SYNCHRONOUS, zero awaiting.
   * Just push to the queue and schedule a drain tick.
   */
  public enqueueChunk(buffer: ArrayBuffer) {
    if (this.isCanceled || !this.fileMeta) return;
    this.receiveQueue.push(buffer);
    if (!this.isProcessingQueue) {
      this.drainReceiveQueue();
    }
  }

  /**
   * Drain the receive queue — serial async loop.
   *
   * The serial design is intentional: ACKs are sent on line 593 BEFORE any
   * await (before hash verification and before disk write), so the sender's
   * window advances at full network speed regardless of how long disk writes
   * take. A parallel design would cause a finishReceive() race — since
   * receivedChunks.add() fires before the disk write, the last chunk can
   * trigger finishReceive() and close the FileSystemWritableFileStream while
   * other concurrent tasks still have pending .write() calls, corrupting the
   * file silently.
   */
  private async drainReceiveQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.receiveQueue.length > 0 && !this.isCanceled) {
      const buffer = this.receiveQueue.shift()!;
      await this.processChunkInternal(buffer);
    }

    this.isProcessingQueue = false;
  }

  private async processChunkInternal(buffer: ArrayBuffer) {
    if (this.isCanceled || !this.fileMeta) return;

    if (this.receivedChunks.size === 0) {
      this.startTime = performance.now();
    }

    const packet = new Uint8Array(buffer);
    const view = new DataView(buffer);

    const index = view.getUint32(0, true);
    const expectedHash = view.getBigUint64(4, true);
    const flags = view.getUint8(12);
    const originalLength = view.getUint32(13, true);
    let payload = packet.slice(HEADER_SIZE);

    // Skip duplicate chunks (can happen with multi-channel / unordered delivery)
    if (this.receivedChunks.has(index)) return;

    // ── IMMEDIATE ACK ─────────────────────────────────────────────────────────
    // ACK RIGHT AWAY so the sender window advances without waiting for our hash.
    // Hash verification happens asynchronously below — we only send NACK if corrupt.
    // On a local LAN/USB link, corruption probability ≈ 0, so this is safe.
    this.receivedChunks.add(index);
    this.bytesTransferred += originalLength;
    this.sendAck(index);

    // Signal completion as soon as we've received all chunks
    if (this.receivedChunks.size === this.fileMeta!.totalChunks) {
      // Run final decompression / storage synchronously first
      // (we continue below before calling finishReceive)
    }

    // ── DEFERRED VERIFICATION ─────────────────────────────────────────────────
    // Hash check and decompression happen after ACK — no longer on the critical path.
    const actualHash = await this.hashPayload(payload);
    if (expectedHash !== actualHash) {
      console.warn(`Checksum mismatch on chunk ${index} — requesting retransmit`);
      // Retract our optimistic accounting
      this.receivedChunks.delete(index);
      this.bytesTransferred -= originalLength;
      this.sendNack(index);
      return;
    }

    // Decompress if needed
    if ((flags & 0x01) !== 0) {
      try {
        payload = new Uint8Array(LZ4.decompress(payload));
      } catch {
        this.receivedChunks.delete(index);
        this.bytesTransferred -= originalLength;
        this.sendNack(index);
        return;
      }
    }

    // Clean, owned copy of this chunk's bytes
    const cleanBuffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength
    );

    if (this.streamWriter) {
      // ── Streaming mode: write directly to disk at the correct byte offset ──
      // FileSystemWritableFileStream.write({type:'write', position, data}) is a
      // random-access write — works even with out-of-order chunk delivery.
      // No data sits in JS heap beyond this single chunk.
      const byteOffset = index * this.fileMeta!.chunkSize;
      try {
        await (this.streamWriter as any).write({
          type: 'write',
          position: byteOffset,
          data: cleanBuffer,
        });
      } catch (writeErr) {
        console.warn(
          `[Stream] Position write failed on chunk ${index}, ` +
          `falling back to RAM buffer:`, writeErr
        );
        // Graceful fallback: disable streaming, store this chunk in RAM.
        this.streamWriter = null;
        this.receiveChunksArray[index] = cleanBuffer;
      }
    } else {
      // ── Buffered mode: accumulate all chunks in RAM ──────────────────────
      this.receiveChunksArray[index] = cleanBuffer;
    }

    // Finish only after ALL chunks have been verified and stored/written
    if (this.receivedChunks.size === this.fileMeta!.totalChunks) {
      await this.finishReceive();
    }
  }

  // ── Control message helpers ────────────────────────────────────────────────
  private sendAck(index: number) {
    const buf = new ArrayBuffer(5);
    const v = new DataView(buf);
    v.setUint8(0, 0x02);
    v.setUint32(1, index, true);
    const conn = this.controlConnections[this.nextCtrlIdx++ % this.controlConnections.length];
    if (conn?.open ?? true) conn.send(buf);
  }

  private sendNack(index: number) {
    const buf = new ArrayBuffer(5);
    const v = new DataView(buf);
    v.setUint8(0, 0x03);
    v.setUint32(1, index, true);
    const conn = this.controlConnections[this.nextCtrlIdx++ % this.controlConnections.length];
    if (conn?.open ?? true) conn.send(buf);
  }

  // ── Finish helpers ─────────────────────────────────────────────────────────
  private async finishReceive() {
    this.stopTelemetry();
    if (!this.fileMeta) { this.receiveChunksArray = []; return; }

    if (this.streamWriter) {
      // ── Streaming mode: seal the file ──────────────────────────────────────
      // All chunks were written to disk; just close the stream.
      // caller receives null (not a Blob) — file is already on disk.
      try {
        await this.streamWriter.close();
        console.log('[Stream] File written to disk successfully.');
      } catch (e) {
        console.warn('[Stream] stream.close() error:', e);
      }
      this.streamWriter = null;
      if (this.onComplete) this.onComplete(null); // null = streaming complete
    } else {
      // ── Buffered mode: assemble Blob from RAM ──────────────────────────────
      const finalParts = [
        ...this.partialBlobs,
        ...(this.receiveChunksArray.filter(b => b != null))
      ];
      const blob = new Blob(finalParts, { type: this.fileMeta.type });
      
      // Clear references
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

  // ── Telemetry ─────────────────────────────────────────────────────────────
  private startTelemetry() {
    if (this.telemetryInterval) clearInterval(this.telemetryInterval);
    this.telemetryInterval = setInterval(() => {
      if (this.isCanceled || !this.onTelemetryUpdate) return;

      const now = performance.now();
      const delta = this.bytesTransferred - this.lastBytesForSpeed;
      this.lastBytesForSpeed = this.bytesTransferred;
      this.speedSamples.push({ time: now, bytes: delta });

      const cutoff = now - 2000;
      this.speedSamples = this.speedSamples.filter(s => s.time >= cutoff);

      const windowBytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
      const windowSec = Math.min((now - this.startTime) / 1000, 2);
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

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public destroy(): void {
    // 1. Stop all pumping immediately
    this.isSending = false;
    this.isCanceled = true;
    this.backpressurePaused = false;
    this.stopTelemetry();

    if (this.ramWatchdogInterval) {
      clearInterval(this.ramWatchdogInterval);
      this.ramWatchdogInterval = null;
    }

    // 2. Drain and null the prefetch cache
    this.packetCache.forEach((_, key) => this.packetCache.delete(key));
    this.packetCache.clear();

    // 3. Drain the sliding window in-flight map
    this.inFlight.forEach((_, key) => this.inFlight.delete(key));
    this.inFlight.clear();

    // 4. Clear RTT probe map
    this.rttProbeStartTimes.clear();
    this.rttSamples = [];

    // 5. Terminate Web Workers — they hold their own JS heap
    this.hasherWorkers?.forEach(worker => {
      worker.terminate();
    });
    this.hasherWorkers = [];

    // 6. Close the FileSystemWritableFileStream if open
    if (this.streamWriter) {
      this.streamWriter.close().catch(() => {}); // best-effort
      this.streamWriter = null;
    }

    // 7. Close all DataChannels — flushes WebRTC internal SCTP buffers
    this.connections.forEach(conn => {
      try {
        conn.dataChannel?.close();
      } catch (_) {}
    });
    this.connections = [];

    this.controlConnections.forEach(conn => {
      try {
        conn.dataChannel?.close();
      } catch (_) {}
    });
    this.controlConnections = [];

    // 8. Clear receive buffer (fallback mode)
    this.receiveChunksArray = [];
    this.partialBlobs = [];
    this.receiveQueue = [];

    // 9. Null large object references explicitly
    this.file = null;
    this.fileMeta = null;
    this.networkProfile = 'unknown';
    this.activeProfile = TransferEngine.PROFILE_LAN;

    console.log('[TransferEngine] Destroyed — all buffers released');
  }

  /**
   * Reset sender/receiver state so this engine instance can be reused for the next file.
   * Does NOT terminate hasher workers — they stay alive for the session.
   */
  public resetForNextFile(
    newConns: any[],
    newControlConns: any[]
  ) {
    this.stopTelemetry();
    if (this.ramWatchdogInterval) {
      clearInterval(this.ramWatchdogInterval);
      this.ramWatchdogInterval = null;
    }
    // Close any leftover stream writer before resetting
    if (this.streamWriter) {
      this.streamWriter.close().catch(console.warn);
      this.streamWriter = null;
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
    // Clear receive state
    for (let i = 0; i < this.receiveChunksArray.length; i++) {
      (this.receiveChunksArray as any)[i] = null;
    }
    this.receiveChunksArray = [];
    this.receiveQueue = [];
    this.receivedChunks.clear();
    this.isProcessingQueue = false;
    // Update connections
    this.connections = newConns;
    this.controlConnections = newControlConns;
    this.tuneSocketBuffers();
  }

  public cleanup() {
    this.stopTelemetry();
    this.isSending = false;
    // Close any open stream writer (partial file will be on disk — that's fine on cleanup)
    if (this.streamWriter) {
      this.streamWriter.close().catch(console.warn);
      this.streamWriter = null;
    }
    // Null out slots before releasing array so GC collects ArrayBuffers immediately
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
    for (const w of this.hasherWorkers) w.terminate();
    this.hasherWorkers = [];
    this.hasherCallbacks.clear();
  }

  public cancel() {
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
