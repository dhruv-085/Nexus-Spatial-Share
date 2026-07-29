---
title: Nexus Spatial Share - Comprehensive 5-Unit Fix Plan
created: 2026-07-23
status: completed
depth: Standard
---

# Technical Implementation Plan: Nexus Spatial Share Bug Fixes

## Problem Frame & Overview

This plan defines the sequential technical implementation for resolving 5 distinct issues in Nexus Spatial Share:
1. **OTP Room Code Auto-Traverse & Deletion Focus Bug**
2. **Premature Auto-Transfer Execution & Camera Permission Decoupling**
3. **Telemetry & Speed/ETA Metrics Discrepancies**
4. **Sender Animation Completion Lifecycle Desynchronization**
5. **Mobile Viewport UI Overlap Between Progress Overlay and Drop Zone Cards**

Each issue is isolated into a dedicated, self-contained Implementation Unit to be executed and verified sequentially without introducing regressions.

---

## Proposed Architecture & Design Decisions

### 1. OTP Focus Navigation Model
* **Backspace Logic**: Pressing `Backspace` on a filled OTP box clears the digit and immediately shifts focus to the preceding box with text selection. Pressing `Backspace` on an empty box shifts focus to the preceding box and clears it.
* **Digit Entry**: Typing a character sets `digits_state[i] = digit`, updates `boxes[i].value`, and auto-advances focus to `boxes[i+1]` using `.setSelectionRange(0, 1)` to prevent selection drop.

### 2. Explicit Transfer Authorization & Permission Isolation
* **Auto-Trigger Removal**: Remove the passive auto-trigger condition `(isGlobalLockedRef.current && !isSourceRef.current && !transferRequestedRef.current)` in `src/App.tsx` upon receiving `FILE_META`.
* **Explicit Action**: Require an explicit user trigger (`#btn-drop` click, Open Palm gesture, or pre-registered `pendingDropActionRef`).
* **Camera Decoupling**: Guarantee `#btn-drop` button is enabled whenever a room is locked for receiver mode, regardless of whether `cameraError` is present or camera permission was granted.

### 3. Symmetrical Per-File Telemetry Calculation
* **Formula Alignment**: In `index.html`, update `updateSenderProgress` to calculate remaining bytes using `currentFile.size * (1 - progress)` instead of `totalBatchBytes * (1 - progress)`, matching `updateReceiverProgress`.

### 4. Sender Completion Lifecycle Auto-Dismiss
* **Lifecycle Sync**: Upon `completeTransfer()`, after presenting `#success-screen`, introduce a 6-second auto-dismiss timer that releases particle system resources (`releaseAll()`), clears gravity wells, hides `#success-screen`, and returns the sender view back to normal idle state, mirroring the receiver's `dismissSuccess()` behavior.

### 5. Progress Overlay Visual Isolation
* **Backdrop Blur & Z-Index Layering**: Apply `background: rgba(10, 10, 10, 0.88); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);` to `#receive-progress` and `#progress-screen`.
* **Element Hiding**: Explicitly add the `hidden` class to `#drop-zone` and control cards while progress overlays are active.

---

## Implementation Units & Detailed Execution Sequence

### Unit 1: OTP Input Focus & Auto-Advance Traversal Engine
* **Target File**: [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2246-L2295)
* **Changes**:
  1. Refactor `keydown` Backspace handler for `#otp-0` .. `#otp-3`:
     - If `digits_state[i] !== ''`: set `digits_state[i] = ''`, set `boxes[i].value = ''`, update QR & globe, and if `i > 0`, call `boxes[i-1].focus(); boxes[i-1].select();`.
     - Else if `i > 0`: set `digits_state[i-1] = ''`, set `boxes[i-1].value = ''`, update QR & globe, call `boxes[i-1].focus(); boxes[i-1].select();`.
  2. Refactor `input` event handler:
     - Extract raw digits, set `digits_state[i] = digit`, set `boxes[i].value = digit`.
     - If `i < 3`, call `boxes[i+1].focus(); boxes[i+1].select();`.
* **Test Scenarios**:
  - Type `1234` rapidly -> verifying cursor auto-advances from box 0 to box 3.
  - Press `Backspace` 4 times from box 3 -> verifying focus moves backward 3 -> 2 -> 1 -> 0 and erases 1 digit per keypress.
  - Re-type `5678` into box 0 -> verifying digits auto-traverse through all 4 boxes smoothly without getting stuck.

---

### Unit 2: Drop Action Auto-Trigger Teardown & Camera Permission Decoupling
* **Target Files**: [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1425-L1431), [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1820-L1848)
* **Changes**:
  1. In `src/App.tsx` inside the `FILE_META` socket message handler, change:
     ```typescript
     if (pendingDropActionRef.current || (isGlobalLockedRef.current && !isSourceRef.current && !transferRequestedRef.current))
     ```
     to:
     ```typescript
     if (pendingDropActionRef.current)
     ```
  2. In `src/App.tsx` control panel sync `useEffect`, ensure `btnDrop.disabled = false` and `btnDrop.style.display = 'flex'` whenever `isGlobalLocked && !isSource`, regardless of `cameraError` or webcam permissions.
* **Test Scenarios**:
  - Receiver joins room and sender clicks Grab/Send -> verifying transfer DOES NOT auto-start upon `FILE_META` arrival.
  - Receiver denies camera permission on laptop -> verifying `#btn-drop` button is still visible, enabled, and successfully starts the transfer when clicked.

---

### Unit 3: Per-File Telemetry & ETA Calculation Alignment
* **Target File**: [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2635-L2670)
* **Changes**:
  1. Update `updateSenderProgress` in `index.html`:
     - Replace `const totalBytes = fileQueue.reduce(...)` with active file size lookup (`const activeFile = fileQueue[idx]; const fileBytes = activeFile ? activeFile.size : 0;`).
     - Calculate remaining time as `const remaining = fileBytes * (1 - progress); const etaSec = speedMbps > 0 ? remaining / (speedMbps * 1048576) : 0;`.
* **Test Scenarios**:
  - Initiate a file transfer between mobile and laptop -> compare speed (MB/s) and ETA (seconds) readouts on both devices.
  - Verify speed and ETA match within expected network sampling tolerances.

---

### Unit 4: Sender Completion Lifecycle & Auto-Dismiss Synchronization
* **Target Files**: [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2677-L2709), [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1575-L1594)
* **Changes**:
  1. In `completeTransfer()` in `index.html`, after showing `#success-screen`, set a 6-second auto-dismiss timer:
     ```javascript
     setTimeout(() => {
       if (document.getElementById('success-screen').classList.contains('visible')) {
         sendAnotherFile();
       }
     }, 6000);
     ```
  2. Ensure `sendAnotherFile()` cleans up particle repellers, resets gravity well states, and returns the UI to normal idle workspace state.
* **Test Scenarios**:
  - Complete a file transfer on Sender -> verifying sender displays success screen and automatically transitions back to normal idle state after 6 seconds or upon clicking "Send Another File".

---

### Unit 5: Progress Overlay Backdrop & Mobile UI Overlap Isolation
* **Target File**: [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L807-L836)
* **Changes**:
  1. Update `#receive-progress` and `#progress-screen` CSS rules in `index.html`:
     - Add `background: rgba(10, 10, 10, 0.88); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);`.
  2. In `updateSenderProgress` and `showReceiveProgress`, add `document.getElementById('drop-zone')?.classList.add('hidden');`.
  3. In `completeTransfer`, `completeReceive`, and `cancelTransfer`, ensure `document.getElementById('drop-zone')?.classList.remove('hidden');`.
* **Test Scenarios**:
  - Trigger file transfer on a mobile viewport -> verify progress ring overlay renders with a crisp blurred background, completely masking the drag-and-drop dialog card underneath.
