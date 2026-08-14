---
title: "Smooth Radiating Water Ripple Rings, ETA Progress Ring Centering & OTP Graph De-duplication"
status: completed
created: 2026-08-14
depth: standard
---

# Technical Implementation Plan

## 1. Problem Frame & Requirements Traceability

### User Requirements
1. **Calm Water Ripple Radiating Rings (`TransferRings`)**:
   - Radiating rings (inward and outward) are currently too fast and prominent, causing visual distraction during transfers.
   - They must be made very subtle and slow so they read like smooth, calm water ripples.
2. **ETA Ring Viewport Centering Across Screens**:
   - Verify and fix the position of the ETA progress ring (`.progress-ring-wrap`) across all screens (`#progress-screen`, `#receive-progress`).
   - Ensure the ETA ring sits in the exact vertical center (`50vh`) of the viewport on all screen sizes (desktop, tablet, mobile), ensuring radiating rings emit symmetrically relative to the background 3D canvas and display boundary.
3. **OTP Room Joining Graph Branch De-duplication**:
   - Repeatedly pressing or typing digits into the room joining OTP boxes causes duplicate connection lines to accumulate between nodes in the 3D network globe graph (`activeEdgeProgress`).
   - Prevent duplicate edges/branches from being created in the graph regardless of how many times a user re-enters or presses the same box/room code.

---

## 2. Key Architecture Decisions & Rationale

### KTD1: Physics & Easing Tuning for `TransferRings`
- **Current Behavior**: `SPAWN_MS = 700`, `LIFE_MS = 1400`, `TRAVEL_PX = 260`, cubic ease-out (`1 - (1-t)^3`) with peak alpha `0.45`. Rings pop rapidly outward/inward with high visibility.
- **Proposed Architecture**:
  - `LIFE_MS`: Extended from `1400`ms to `3400`ms (slow, serene 3.4-second ripple duration).
  - `SPAWN_MS`: Extended from `700`ms to `1350`ms (deliberate, calm spacing between ripples).
  - `MAX_RINGS`: Capped at `4` concurrent rings.
  - `TRAVEL_PX`: Set to `240`px for smooth, expansive radial travel.
  - **Easing Curve (`ringRadius`)**:
    - Mode `out`: Quadratic ease-out `r0 + TRAVEL_PX * (1 - Math.pow(1 - t, 2))` (replaces aggressive cubic expansion with fluid ripple motion).
    - Mode `in`: Smooth sine ease-in `r0 + TRAVEL_PX * (1 - Math.sin((t * Math.PI) / 2))` (collapses inward gently without sudden acceleration).
  - **Opacity Envelope (`alpha`)**:
    - Peak opacity reduced from `0.45` to `0.16` (subtle visual presence).
    - Smooth fade-in for `t < 0.2` (`0` → `0.16`), followed by a gradual fade-out to `0` at `t = 1.0`.

### KTD2: 3-Stage Flex Layout for Viewport-Centered ETA Progress Rings
- **Current Behavior**: `#progress-screen` and `#receive-progress` use `justify-content: center` over all children (`.progress-file-label` above the ring; `.progress-meta` card + `#cancel-area` below the ring). Because bottom elements are ~130px tall and top elements are ~16px tall, `.progress-ring-wrap` is pushed ~57px above the viewport vertical midpoint.
- **Proposed Architecture**:
  - Re-structure CSS layout for `#progress-screen` and `#receive-progress` into a 3-stage flex container:
    1. **Top Section (`.progress-top-region`)**: `flex: 1`, aligns header label (`.progress-file-label` / `.receive-label`) at the bottom of the top slot.
    2. **Center Section (`.progress-ring-wrap`)**: Fixed `180px x 180px` geometry, naturally locked at `y = 50vh` (screen center).
    3. **Bottom Section (`.progress-bottom-region`)**: `flex: 1`, contains `.progress-meta` and `#cancel-area` / `#rx-cancel-area` aligned at the top of the bottom slot.
  - This guarantees `.progress-ring-wrap` is vertically centered at `50%` of the viewport height across all screen resolutions and mobile notch safe areas (`env(safe-area-inset-top)`).
  - Matches the origin returned by `resolveOrigin()` to `(window.innerWidth / 2, window.innerHeight / 2)`, aligning canvas particle repellers/attractors, radiating water ripples, and progress ring UI.

### KTD3: Graph Edge Uniqueness Validation & Clean Slot Re-activation
- **Current Behavior**: `activateNode(slot, digitChar)` iterates active slots `s !== slot` and unconditionally pushes `{ i: activeNodes[s], j: nodeIdx, t: 0 }` to `activeEdgeProgress`. Re-typing or clicking the same OTP box appends duplicate edge objects, accumulating thick multi-stroke lines.
- **Proposed Architecture**:
  - In `activateNode(slot, digitChar)`:
    1. Calculate `nodeIdx = nodeForDigit(slot, d)`.
    2. If `activeNodes[slot] === nodeIdx`, return early (no-op for same node re-activation).
    3. If `activeNodes[slot] !== -1` and `activeNodes[slot] !== nodeIdx`, execute `deactivateNode(slot)` first to purge old connection lines attached to the previous node.
    4. Set `activeNodes[slot] = nodeIdx` and `glowTarget[nodeIdx] = 1`.
    5. For each active slot `s !== slot`:
       - Check if `activeEdgeProgress` already contains an edge between `activeNodes[s]` and `nodeIdx` (checking both `(ae.i === nodeA && ae.j === nodeB)` and `(ae.i === nodeB && ae.j === nodeA)`).
       - Only push `{ i: activeNodes[s], j: nodeIdx, t: 0 }` if no matching edge exists.

---

## 3. Repo Touch Surface

- `index.html`:
  - `Chapter 3A — Transfer Visuals`: Retune `SPAWN_MS`, `LIFE_MS`, `TRAVEL_PX`, `MAX_RINGS`, `ringRadius`, and `alpha` rendering in `TransferRings`.
  - `CSS Layout Styles`: Update `#progress-screen` and `#receive-progress` flex layout rules to center `.progress-ring-wrap` at `50vh`.
  - `Chapter 2 — 3D Network Globe & OTP`: Refactor `activateNode`, `deactivateNode`, and edge creation checks in `index.html`.
- `test_otp.cjs`:
  - Extend Playwright automated suite with a test verifying `activeEdgeProgress` de-duplication upon repeated OTP digit entry.

---

## 4. Implementation Units

### Unit 1: Retune `TransferRings` Physics & Water Ripple Easing Curves

**Goal**: Transform radiating rings in `index.html` into subtle, slow, calm water ripples for both inward ('in') and outward ('out') modes.

**Files**:
- `index.html` (lines ~2470–2605)

**Detailed Guidance**:
1. Update constants in `index.html`:
   ```javascript
   const SPAWN_MS    = 1350;  // interval between ring births (was 700)
   const LIFE_MS     = 3400;  // ring lifetime (was 1400)
   const TRAVEL_PX   = 240;   // radial travel distance (was 260)
   const MAX_RINGS   = 4;     // concurrent cap
   ```
2. Refactor `ringRadius` easing curve:
   ```javascript
   const ringRadius = (ringMode, t, r0) => ringMode === 'out'
     ? r0 + TRAVEL_PX * (1 - Math.pow(1 - t, 2))  // quadratic ease-out
     : r0 + TRAVEL_PX * (1 - Math.sin((t * Math.PI) / 2)); // smooth sine ease-in
   ```
3. Refactor `drawFrame` ring opacity and width:
   ```javascript
   const PEAK_ALPHA = 0.16;
   let alpha, width;
   if (mode === 'out') {
     alpha = t < 0.2 ? PEAK_ALPHA * (t / 0.2) : PEAK_ALPHA * (1 - (t - 0.2) / 0.8);
     width = lerp(1.8, 0.6, t);
   } else {
     alpha = t < 0.25 ? PEAK_ALPHA * (t / 0.25) : lerp(PEAK_ALPHA, 0.02, (t - 0.25) / 0.75);
     width = lerp(0.6, 1.8, t);
   }
   ```
4. Verify reduced motion fallback (`reducedMotion()`) remains functional.

**Test Scenarios**:
1. Trigger `window.enterTransferVisuals('out')` in browser console:
   - Verify rings radiate outward slowly over ~3.4 seconds.
   - Verify ring opacity is subtle (peak ~0.16) and fades gracefully at the edge.
2. Trigger `window.enterTransferVisuals('in')`:
   - Verify rings collapse inward smoothly without sudden acceleration spikes.
3. Call `window.resetTransferVisuals()`:
   - Verify animation frame is cancelled and canvas is cleared instantly.

---

### Unit 2: Symmetric Viewport Centering of ETA Progress Rings Across Screens

**Goal**: Center `.progress-ring-wrap` visually at `50vh` across `#progress-screen` and `#receive-progress` on desktop, tablet, and mobile viewports.

**Files**:
- `index.html` (CSS styling around lines 590–650, 805–840, 960–975; HTML structure around lines 1680–1715, 1790–1815)

**Detailed Guidance**:
1. Wrap top labels and bottom meta/action controls in dedicated flex containers inside `#progress-screen` and `#receive-progress`:
   ```html
   <div id="progress-screen">
     <div class="progress-top-region">
       <div class="progress-file-label" id="progress-file-label"></div>
     </div>
     <div class="progress-ring-wrap">...</div>
     <div class="progress-bottom-region">
       <div class="progress-meta">...</div>
       <div id="cancel-area">...</div>
     </div>
   </div>
   ```
2. Update CSS for `#progress-screen` and `#receive-progress`:
   ```css
   #progress-screen, #receive-progress {
     position: fixed; inset: 0; z-index: 25;
     display: flex; flex-direction: column; align-items: center; justify-content: space-between;
     padding: calc(64px + env(safe-area-inset-top, 0px)) 24px 36px;
     opacity: 0; pointer-events: none; transition: opacity 0.3s;
     background: transparent;
   }
   .progress-top-region, .progress-bottom-region {
     flex: 1; display: flex; flex-direction: column; align-items: center; width: 100%;
   }
   .progress-top-region { justify-content: flex-end; padding-bottom: 20px; }
   .progress-bottom-region { justify-content: flex-start; padding-top: 20px; gap: 16px; }
   ```
3. Verify pointer events scoping (`pointer-events: none` on container overlays, `pointer-events: auto` on interactive cards).

**Test Scenarios**:
1. Open sender progress screen `#progress-screen`:
   - Inspect `.progress-ring-wrap` bounding box: verify `rect.top + rect.height/2` equals `window.innerHeight / 2` (within ±2px).
2. Open receiver progress screen `#receive-progress`:
   - Inspect `.progress-ring-wrap` bounding box: verify exact vertical center alignment.
3. Test mobile viewport (width: 375px, height: 667px):
   - Confirm ETA ring remains centered without overlapping top bar or bottom navigation area.

---

### Unit 3: De-duplicate 3D Globe Network Graph Branches on OTP Digit Re-entry

**Goal**: Prevent duplicate connection lines from accumulating in `activeEdgeProgress` when digits are re-entered or repeatedly pressed in room code boxes.

**Files**:
- `index.html` (lines ~2125–2140)
- `test_otp.cjs`

**Detailed Guidance**:
1. Update `activateNode(slot, digitChar)` in `index.html`:
   ```javascript
   function activateNode(slot, digitChar) {
     const d = parseInt(digitChar);
     if (isNaN(d)) return;
     const nodeIdx = nodeForDigit(slot, d);
     if (activeNodes[slot] === nodeIdx) return; // No-op if node already active for this slot
     if (activeNodes[slot] !== -1 && activeNodes[slot] !== nodeIdx) {
       deactivateNode(slot); // Flush old node's edges for this slot
     }
     activeNodes[slot] = nodeIdx;
     glowTarget[nodeIdx] = 1;
     for (let s = 0; s < 4; s++) {
       if (s !== slot && activeNodes[s] !== -1) {
         const nodeA = activeNodes[s], nodeB = nodeIdx;
         const exists = activeEdgeProgress.some(
           ae => (ae.i === nodeA && ae.j === nodeB) || (ae.i === nodeB && ae.j === nodeA)
         );
         if (!exists) {
           activeEdgeProgress.push({ i: nodeA, j: nodeB, t: 0 });
         }
       }
     }
     kick();
   }
   ```
2. Update `deactivateNode(slot)` in `index.html`:
   ```javascript
   function deactivateNode(slot) {
     const pn = activeNodes[slot];
     if (pn !== -1) {
       glowTarget[pn] = 0;
       activeEdgeProgress = activeEdgeProgress.filter(ae => ae.i !== pn && ae.j !== pn);
     }
     activeNodes[slot] = -1;
     kick();
   }
   ```
3. Extend `test_otp.cjs` to include a test case verifying `activeEdgeProgress` length when repeatedly typing into the same box:
   - Type digit '5' into box 0 twenty times.
   - Assert `activeEdgeProgress.length === 0` (single node has no connections to other slots).
   - Type '1234' into boxes 0-3, then repeatedly press key '4' in box 3 ten times.
   - Assert `activeEdgeProgress.length` does not grow beyond the maximum expected distinct edge count (3 edges connecting 4 slots).

**Test Scenarios**:
1. Type single digit into box 0 repeatedly:
   - Verify zero edges created in `activeEdgeProgress`.
2. Enter full 4-digit code '1234', then re-click and press '4' in box 3 ten times:
   - Verify graph edge count stays strictly capped at unique slot pair count.
3. Erase digits via Backspace and re-type:
   - Verify graph edge count matches active nodes cleanly without ghost lines.

---

## 5. Verification Plan & Test Commands

### Automated Test Execution
Run the Playwright OTP regression suite:
```bash
node test_otp.cjs
```

### Manual Visual & Functional Verification
1. Start dev server:
   ```bash
   npm run dev
   ```
2. **Radiating Rings Visual Test**:
   - Select a file and click Send.
   - Observe outward radiating rings: verify smooth, gentle water ripple expansion (~3.4s per ring, subtle ~0.16 opacity).
   - In another browser tab/window, open receiver mode.
   - Observe inward radiating rings: verify smooth inward collapse without harsh acceleration.
3. **ETA Progress Ring Centering Test**:
   - Resize browser window across desktop (1920x1080), laptop (1440x900), and mobile emulation (375x667).
   - Open browser developer tools and check bounding rect of `.progress-ring-wrap`: verify ring center sits at `window.innerHeight / 2`.
4. **OTP Graph Branch De-duplication Test**:
   - On room joining card, enter digits `1234`.
   - Repeatedly click box 0 and type `1` five times.
   - Inspect console variable `window._debugGlobe?.() || activeEdgeProgress.length`: verify total edges count remains constant and lines on globe do not bloat or multiply.
