const fs = require('fs');

const file = 'src/lib/TransferEngine.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Constants
code = code.replace(
  /export const CHUNK_SIZE = 512 \* 1024;.*?\n.*?\nconst PREFETCH_BATCH = 20;.*?\nconst PACKET_CACHE_MAX = PREFETCH_BATCH \* 3;.*?\n.*?\nconst BACKPRESSURE_LOW  =  6 \* 1024 \* 1024;.*?\n.*?\nconst WINDOW_FLOOR   = 32;.*?\nconst WINDOW_CEILING = 128;.*?\nconst BACKPRESSURE_HARD_CAP = 128 \* 1024 \* 1024;.*?\n.*?\n.*?\n.*?\nconst WINDOW_GROW_STEP = 2;/m,
  `export const CHUNK_SIZE = 2 * 1024 * 1024;              // 2 MB per chunk
export const HEADER_SIZE = 17;                     // 4(idx)+8(hash)+1(flags)+4(origLen)
const PREFETCH_BATCH = 20;                         // 40 MB prefetch
const PACKET_CACHE_MAX = 30;                       // 60 MB RAM cap
// Backpressure thresholds
const BACKPRESSURE_LOW_BYTES  = 16 * 1024 * 1024;  // 16 MB — resume pumping
// ── Adaptive window constants ─────────────────────────────────────────────────────
const WINDOW_FLOOR   = 16;                         // never go below 16 (= 32 MB in-flight)
const WINDOW_CEILING = 64;                         // never go above 64 (= 128 MB in-flight)
const BACKPRESSURE_HARD_CAP = 96 * 1024 * 1024;    // 96 MB absolute ceiling
const WINDOW_GROW_STEP = 1;                        // chunks to add per growth tick
const STALE_PAUSE_TIMEOUT_MS = 4000;               // 4s watchdog`
);

// 2. Slow start vars
code = code.replace(
  /\/\/ dynamicBackpressureHigh grows with the window/m,
  `// dynamicBackpressureHigh grows with the window to avoid false pauses.
  private slowStartActive = true;
  private slowStartThreshold = 32; // chunks — switch to AIMD when window hits this`
);
code = code.replace(/private dynamicBackpressureHigh = WINDOW_FLOOR \* CHUNK_SIZE \* 2;/m, `private dynamicBackpressureHigh = WINDOW_FLOOR * CHUNK_SIZE * 1.5;`);

// 3. tuneSocketBuffers
code = code.replace(
  /conn\.dataChannel\.bufferedAmountLowThreshold = BACKPRESSURE_LOW;/m,
  `conn.dataChannel.bufferedAmountLowThreshold = BACKPRESSURE_LOW_BYTES;`
);

// 4. growWindow and updateDynamicBackpressure
code = code.replace(
  `  private growWindow(): void {\n    if (this.currentWindowSize >= WINDOW_CEILING) return;\n    this.acksSinceGrow++;\n    const threshold = Math.ceil(this.currentWindowSize / 4);\n    if (this.acksSinceGrow < threshold) return;\n\n    this.acksSinceGrow = 0;\n    this.currentWindowSize = Math.min(WINDOW_CEILING, this.currentWindowSize + WINDOW_GROW_STEP);\n    this.dynamicBackpressureHigh = Math.min(\n      this.currentWindowSize * CHUNK_SIZE * 2,\n      BACKPRESSURE_HARD_CAP\n    );\n    console.log(\n      \`[Window] ↑ \${this.currentWindowSize} chunks \` +\n      \`(\${(this.currentWindowSize * CHUNK_SIZE / 1048576).toFixed(0)} MB in-flight)\`\n    );\n  }`,
  `  private growWindow(): void {
    if (this.currentWindowSize >= WINDOW_CEILING) return;
    this.acksSinceGrow++;
    const threshold = Math.ceil(this.currentWindowSize / 8);
    if (this.acksSinceGrow < threshold) return;

    this.acksSinceGrow = 0;
    this.currentWindowSize = Math.min(WINDOW_CEILING, this.currentWindowSize + WINDOW_GROW_STEP);
    this.updateDynamicBackpressure();
    console.log(
      \`[Window] ↑ \${this.currentWindowSize} chunks \` +
      \`(\${(this.currentWindowSize * CHUNK_SIZE / 1048576).toFixed(0)} MB in-flight)\`
    );
  }`
);

// 5. shrinkWindow
code = code.replace(
  `  private shrinkWindow(): void {\n    const prev = this.currentWindowSize;\n    this.currentWindowSize = Math.max(WINDOW_FLOOR, Math.floor(this.currentWindowSize * 0.75));\n    this.acksSinceGrow = 0;\n    this.dynamicBackpressureHigh = Math.min(\n      this.currentWindowSize * CHUNK_SIZE * 2,\n      BACKPRESSURE_HARD_CAP\n    );\n    if (this.currentWindowSize !== prev) {\n      console.log(\`[Window] ↓ \${prev}→\${this.currentWindowSize} chunks (backpressure MD)\`);\n    }\n  }`,
  `  private shrinkWindow(): void {
    const prev = this.currentWindowSize;
    if (this.slowStartActive) {
      this.slowStartThreshold = Math.max(Math.floor(this.currentWindowSize * 0.75), WINDOW_FLOOR);
      this.slowStartActive = false; // drop into AIMD immediately after first congestion
    }
    this.currentWindowSize = Math.max(WINDOW_FLOOR, Math.floor(this.currentWindowSize * 0.75));
    this.acksSinceGrow = 0;
    this.updateDynamicBackpressure();
    if (this.currentWindowSize !== prev) {
      console.log(\`[Window] ↓ \${prev}→\${this.currentWindowSize} chunks (backpressure MD)\`);
    }
  }

  private updateDynamicBackpressure() {
    this.dynamicBackpressureHigh = Math.min(
      this.currentWindowSize * CHUNK_SIZE * 1.5,
      BACKPRESSURE_HARD_CAP
    );
  }`
);

// 6. startTransfer slow start resets
code = code.replace(
  `    this.currentWindowSize = WINDOW_FLOOR;\n    this.acksSinceGrow = 0;\n    this.dynamicBackpressureHigh = WINDOW_FLOOR * CHUNK_SIZE * 2;`,
  `    this.currentWindowSize = WINDOW_FLOOR;
    this.acksSinceGrow = 0;
    this.slowStartActive = true;
    this.slowStartThreshold = 32;
    this.updateDynamicBackpressure();`
);

// 7. processAck
code = code.replace(
  `    if (this.isSending && !this.backpressurePaused) {\n      this.growWindow();\n    }`,
  `    if (this.isSending && !this.backpressurePaused) {
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
    }`
);

// 8. processAck Watchdog
code = code.replace(
  `      if (total <= BACKPRESSURE_LOW) {\n        this.backpressurePaused = false;\n        this.backpressurePausedSince = 0;\n      }\n\n      // Safety net #2: Stale-pause watchdog — if we've been paused for > 8 s\n      // but the buffer has already drained, the event AND the poll above both\n      // missed it (extremely rare). Force-clear to prevent permanent stall.\n      if (\n        this.backpressurePaused &&\n        this.backpressurePausedSince > 0 &&\n        Date.now() - this.backpressurePausedSince > 8_000 &&\n        total <= BACKPRESSURE_LOW\n      ) {\n        console.warn('[BackpressureGuard] Stale pause detected (>8s). Force-clearing.');\n        this.backpressurePaused = false;\n        this.backpressurePausedSince = 0;\n      }`,
  `      if (total <= BACKPRESSURE_LOW_BYTES) {
        this.backpressurePaused = false;
        this.backpressurePausedSince = 0;
      }

      // Safety net #2: Stale-pause watchdog
      if (
        this.backpressurePaused &&
        this.backpressurePausedSince > 0 &&
        Date.now() - this.backpressurePausedSince > STALE_PAUSE_TIMEOUT_MS
      ) {
        if (total < BACKPRESSURE_LOW_BYTES) {
          console.warn('[TransferEngine] Stale pause cleared by watchdog');
          this.backpressurePaused = false;
          this.backpressurePausedSince = 0;
        } else {
          // Still genuinely congested — reset the watchdog timer, don't force-clear
          this.backpressurePausedSince = Date.now();
        }
      }`
);

fs.writeFileSync(file, code, 'utf8');
