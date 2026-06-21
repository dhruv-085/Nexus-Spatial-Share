# Nexus Spatial Share - UI & Animation Bug Fixes Specification

This document outlines the identified bugs in the Nexus Spatial Share web application, their root causes, and the concrete technical plan to resolve them. No code changes have been made yet, in accordance with instructions.

---

## 1. Bug Index & Root Cause Analysis

### Bug 1: 1200% Progress Display, Screen Blue-Out & Lag
* **Symptom**: The file sharing completion shows values like `1200%`, the background light behind the sphere gets brighter and brighter until the screen turns completely blue, and the website experiences severe rendering lag.
* **Root Cause**: 
  1. In `src/App.tsx`, the `transferProgress` state variable is a percentage value ranging from `0` to `100`.
  2. The HTML/Canvas particle system in `index.html` expects the progress parameter to be a fraction ranging from `0.0` to `1.0` (e.g. `0.5` represents 50%).
  3. When React passes `transferProgress` (e.g., `80`), `index.html` computes `Math.floor(prog * 100) = 8000%`.
  4. In `index.html`'s loop, the canvas bloom gradient radius (`bloomR = SPHERE_R * 0.6 * (0.7 + prog*0.3)`) and lead particle shadow blur (`14 * prog`) scale directly with the progress value. When `prog` exceeds `1.0` and goes up to `100.0`, the gradient radius covers the entire screen, and the shadow blur grows to thousands of pixels, causing extreme rendering lag (overdraw) and the solid blue screen.

### Bug 2: Missing Cancel Button on Receiver & Animation Freeze on Cancel
* **Symptom**: Only the sender gets a Cancel Transfer button (which sometimes disappears). The receiver has no Cancel button. When the sender cancels, the receiver's animation gets stuck, forcing them to leave the room to reset.
* **Root Cause**:
  1. The receiver's screen markup (`#receive-progress`) does not include any cancel button or cancel confirmation panel.
  2. When a transfer is cancelled, React resets its internal connection states and sends a WebRTC control packet, but the HTML interface (`index.html`) is never notified. As a result, the active canvas particle and progress loop (`rxRafId`) on the receiver side continues to run indefinitely, leaving the UI frozen.
  3. When a transfer completes or fails, the cancel buttons are not reset, which can lead to them staying hidden.

### Bug 3: Leaving the Room Disconnects Both Clients
* **Symptom**: When one client clicks "Leave Room", both clients are thrown back to the home screen.
* **Root Cause**:
  1. When Client A leaves the room, the signaling server broadcasts `'peer-disconnected'` to Client B.
  2. On receiving `'peer-disconnected'`, Client B's HTML interface triggers `window.showPeerDisconnected()`.
  3. In `index.html`, `showPeerDisconnected` automatically calls `window.leaveRoom()` or `window.leaveReceiver()` when there is no active transfer (`midTransfer` is false or undefined). This forces Client B back to the home screen and disconnects their socket.

### Bug 4: Sender 3D Sphere Animation and Telemetry Displays
* **Symptom**: The sender animation forms a 3D sphere, but the user wants to inverse the receiver's converging animation so that particles shoot outwards from the center. The sender should show a progress ring and stats overlay matching the receiver's DOM layout.
* **Root Cause**:
  1. Currently, the sender triggers `ParticleSystem.formSphere()`, which activates the 3D Fibonacci sphere mode.
  2. The sender's DOM progress elements (ring, stats, filename) are hidden during this mode, with the canvas attempting to draw them instead.
  3. The particle system does not have a repelling mode that shoots particles outwards.

---

## 2. Technical Fix Plan

### Fix 1: Telemetry Scale Alignment
* **File to modify**: `src/App.tsx`
* **Changes**:
  * Divide `transferProgress` by `100` before passing it to `ParticleSystem.startTransfer` and `updateReceiverProgress`:
    ```typescript
    // In src/App.tsx:
    (window as any).ParticleSystem?.startTransfer(
      () => transferProgress / 100,
      () => telemetry?.speedMBps ?? 0
    );
    (window as any).updateReceiverProgress?.(transferProgress / 100, telemetry?.speedMBps ?? 0);
    ```
  * This aligns the telemetry scales, resolving the `1200%` bug and automatically preventing the canvas overdraw lag and blue-out.

### Fix 2: Symmetrical Cancel Buttons & UI State Synchronization
* **Files to modify**: `index.html`, `src/App.tsx`
* **Changes in `index.html`**:
  * Add a cancel button `#btn-rx-cancel` and a confirmation dialog `#rx-cancel-confirm` to the receiver screen `#receive-progress`.
  * Define helper functions `window.showRxCancelConfirm()` and `window.hideRxCancelConfirm()`.
  * Create a global cleanup handler `window.onTransferCancelled()` that:
    1. Cancels any running animation loop frame (`transferRafId`, `rxRafId`).
    2. Resets UI variables (`isTransferring = false`, `sphereFormed = false`, `rxTransferActive = false`).
    3. Hides the progress and cancel overlay containers (`progress-screen`, `receive-progress`, `receive-success`, `transfer-error-screen`).
    4. Resets the cancel confirmation panels.
    5. Releases the particle system (`ParticleSystem.releaseAll()`).
    6. Returns the device back to the shared workspace screen (`window.transitionToSender(roomCode)`).
* **Changes in `src/App.tsx`**:
  * Call `(window as any).onTransferCancelled?.()` inside React's `cancelTransfer` and the WebRTC control message handler for `"CANCEL_TRANSFER"`.

### Fix 3: Peer Departure Isolation
* **File to modify**: `index.html`
* **Changes**:
  * Update `window.showPeerDisconnected()` to remove the automatic redirect to `leaveRoom` / `leaveReceiver` when `midTransfer` is false.
  * In `onPeerLeft()`, change the top bar center pill to display an amber "Waiting for Peer" dot rather than hiding or kicking the user:
    ```javascript
    const centerBar = document.getElementById('top-bar-center');
    if (centerBar) {
      centerBar.innerHTML = '<div class="connected-dot amber"></div><span>Waiting for Peer</span>';
    }
    ```
  * This keeps the remaining client in the room, ready for the other peer to rejoin.

### Fix 4: Outward Repeller Animation & DOM Telemetry
* **File to modify**: `index.html`
* **Changes**:
  * Modify `setGravityWell(x, y, strength, isRepeller)` to set `gravWell = { x, y, strength, isRepeller }`.
  * Update `updateDrift()` to handle `gw.isRepeller === true`:
    ```javascript
    if (gw && gw.isRepeller) {
      const gx = this.x - gw.x, gy = this.y - gw.y;
      const gd = Math.sqrt(gx*gx + gy*gy) || 1;
      // If particles reach borders or travel too far, reset them to the center
      if (gd > Math.max(canvas.width, canvas.height) * 0.5 || 
          this.x < 2 || this.x > canvas.width - 2 || 
          this.y < 2 || this.y > canvas.height - 2) {
        this.x = gw.x;
        this.y = gw.y;
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 5;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
      } else {
        const s = gw.strength * 60;
        this.vx += (gx/gd) * s * 0.012;
        this.vy += (gy/gd) * s * 0.012;
      }
    }
    ```
  * In the sender's Grab event listener:
    * Replace `ParticleSystem.formSphere()` with `ParticleSystem.setGravityWell(CX(), CY(), 0.5, true)` (starts outward particles).
    * Do **not** hide the progress ring, stats, and file labels on the `#progress-screen`.
  * Implement `window.updateSenderProgress(progress, speedMbps)` to update the sender DOM progress indicators, matching the receiver's visual styling.

---

## 3. Resolved Bugs (Session: 2026-06-21)

### ✅ Bug Fix: Animation Stuck on Cancel (Cross-Scope IIFE Variable Bug)
* **Symptom**: When a transfer is cancelled mid-flight, both sender and receiver animations stay stuck in a loop. The particles keep moving and the progress UI never resets, even after the drag-and-drop dialogue appears again.
* **Root Cause**: The `onTransferCancelled()` function lives inside **Chapter 3's IIFE** (Sender Workspace, lines ~2411-2767). It referenced `rxRafId`, `rxTransferActive`, `rxProgress`, and `rxSpeed` directly — but these variables are declared inside **Chapter 4's IIFE** (Receiver Workspace, lines ~2774+). Due to JavaScript's IIFE scoping rules, the references inside Chapter 3 silently created implicit global variables instead of modifying the real IIFE-scoped variables in Chapter 4. The real `rxRafId` animation frame was never cancelled, so the receiver's animation loop continued indefinitely.
  * Additionally, `animRaf` (the incoming sphere fly-in animation) was local to the `animateIncomingSphere()` function and could not be cancelled from any external cleanup path.
* **Fix Applied** (in `index.html`):
  1. **Exposed `window.stopReceiverAnimation()`** from inside Chapter 4's IIFE, which properly cancels `rxRafId`, `incomingSphereRafId`, resets `rxTransferActive`, `rxProgress`, `rxSpeed`, and clears the ripple canvas.
  2. **Modified `onTransferCancelled()`** in Chapter 3 to call `window.stopReceiverAnimation()` instead of directly referencing Chapter 4's local variables.
  3. **Hoisted `animRaf`** from a local variable inside `animateIncomingSphere()` to an IIFE-scoped variable `incomingSphereRafId`, so both `stopReceiverAnimation()` and `leaveReceiver()` can cancel it.
  4. **Updated `leaveReceiver()`** to also cancel `incomingSphereRafId`.
* **Pattern**: This is the same cross-scope IIFE variable bug documented in NexusIntegrationKnowledge.md Lesson #5. The fix follows the prescribed practice of exposing dedicated setter/teardown functions from inside the IIFE scope.

### ✅ Bug Fix: Sender Repeller Particle Animation Symmetry
* **Symptom**: The sender's outward-shooting particles were too fast and too dense compared to the receiver's inward-converging particles, breaking visual symmetry.
* **Root Cause**: Repeller reset speed was `1.5 + Math.random() * 1.0` (1.5–2.5 units/frame) — 5-9× faster than the attractor's reset speed of `(Math.random()-.5)*.4` (~0–0.28 units/frame). The attractor lets its force do the gradual acceleration; the repeller was launching at terminal velocity.
* **Fix Applied** (in `index.html`, Chapter 1 Particle System):
  1. **Matched initial outward speed and formula**: Changed particle reset speed from polar angles to the exact Cartesian formula used by the attractor: `this.vx = (Math.random() - 0.5) * 0.4` and `this.vy = (Math.random() - 0.5) * 0.4`.
  2. **Matched center offset range**: Particles now respawn with `(Math.random() - 0.5) * 6` pixel jitter around the center, matching the attractor's center distance threshold.
  3. **Preserved identical force constant**: The outward acceleration force `gw.strength * 60 * 0.012` is unchanged and matches the attractor's pull force exactly, ensuring symmetrical particle trajectory physics.
  4. **Preserved boundary behavior**: Same `0.5 * diagonal` distance threshold and screen-edge detection for particle recycling.

### ✅ Bug Fix: Sender Particles Moving Inward (Gravity Well Operation Order)
* **Symptom**: Despite repeller physics being correct in `updateDrift()`, sender particles moved inward (attractor behavior) instead of outward.
* **Root Cause**: In the grab handler (Chapter 3, line ~2543), the three operations were ordered as: **set → stop → start**. `stopGravityWellIdle()` calls `clearGravityWell()` which sets `gravWell = null`, wiping the `isRepeller=true` state that was just set. When `startGravityWellIdle()` then runs its first `oscillate()` frame via `requestAnimationFrame`, `isRepeller()` reads `null` → returns `false` → sets the well as an attractor permanently.
* **Fix Applied**: Reordered to **stop → set → start**: stop the old loop first (clears gravWell to null), then set the repeller (gravWell.isRepeller=true), then start the new oscillation loop (reads the fresh repeller state on its first frame).
