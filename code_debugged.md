# Nexus Spatial Share - Resolved Bugs Directory

This file documents all bugs fixed in this project. **All future agent sessions and developers debugging new issues using `/ce-debug` in this folder MUST read this file first before analyzing or debugging.**

---

## 1. UI Overlapping & Screen Transition Issues
* **Symptom**: Control panels and screens overlapped, and automatic screen transition did not occur reliably.
* **Root Cause**: Uncoordinated DOM visibility transitions (`visible` and `hidden` classes) in `index.html` and `App.tsx` clashed during state updates.
* **Fix**: Locked layout control panels symmetrically. Ensured that whenever screen transitions happen (e.g. sender mode, receiver mode, success screen), all competing UI screen container classes are explicitly reset (removed `visible`, added `hidden` where appropriate) before adding `visible`.

---

## 2. Room Joining Card Scrolling & Sizing (Mobile/Desktop)
* **Symptom**: The room joining card was zoomed in too much, requiring scrolling to see the full content, and the globe canvas was off-center or clipping on mobile viewports.
* **Root Cause**: Hardcoded sizes for the canvas elements and large margin/padding constraints on the containment card.
* **Fix**: Adjusted globe rendering logic to dynamically scale canvas radius based on screen size (reduced to `50` on mobile). Set card container styling to enable standard vertical scrolling and responsive margins, preventing viewport clipping.

---

## 3. Persistent "Room is Full" and Rejoining Issues (Connection Churn/React StrictMode)
* **Symptom**: Reconnecting to a room from the same device (e.g., after a page refresh or connection drop) returned a "Room is Full" error.
* **Root Cause**: React StrictMode dual-mounting or quick connection drops left stale socket instances active in the server's memory. The server's 2-minute grace period preserved these sockets, blocking rejoining.
* **Fix**: 
  1. Introduced `clientIdRef` (mapped to `localStorage.getItem("nexus_client_id")`) transmitted upon joining.
  2. Implemented socket ID replacement logic in `server.ts` when a client joins with the same `clientId`.
  3. Modified `server.ts` to purge disconnected sockets (where `peerSocket.connected === false`) immediately during joining checks, avoiding polling lag issues.

---

## 4. `[object Object]` Room Code Display
* **Symptom**: Room code displays as `[object Object]` when joining or creating a room, especially when camera permissions are not initially granted.
* **Root Cause**: The socket signaling code passed state payloads as structured objects to callbacks which directly set DOM text elements without string sanitization.
* **Fix**: Added explicit payload type/structure validation in `App.tsx` and `index.html` to extract raw string room codes and filter out object references.

---

## 5. Simulated Transfer UI Ring Flaw
* **Symptom**: The transfer completion ring and speed text were rendered below the canvas globe/sphere instead of aligning with it.
* **Root Cause**: Coordinate mismatch where particle system center `(cx, cy)` differed from progress ring rendering coordinates `(ringCX, ringCY)`. Duplicate drawing calls also caused blurred overlap.
* **Fix**: Aligned center coordinates `ringCY = cy` directly in canvas rendering logic, adjusted typography scaling, and removed duplicate overlapping drawing calls.

---

## 6. WebRTC File Sharing Blocked / Sender Stub Fallback
* **Symptom**: Clicking Send switched the other device to Receive mode, but the file transfer did not start.
* **Root Cause**: Senders fell back to simulated transfers too eagerly. The real WebRTC completion handler lacked callback execution logic, leaving transfers in a stub state.
* **Fix**: Restored `_completeTransferCh3` callback hooks so the real WebRTC engine drives chunk updates and triggers the success UI screen when finished.

---

## 7. Home Screen Visual "Room Full" propagation
* **Symptom**: When the signaling server rejected a connection as full, the home screen UI didn't show the error visual or shake effect.
* **Root Cause**: `showRoomError` in `index.html` was not exposed globally to the `window` object, so `App.tsx` couldn't call it.
* **Fix**: Exposed `showRoomError` as `window.showRoomError = showRoomError` and updated `App.tsx` to call it when receiving `status === 'full'`.

---

## 8. Animation Stuck on Cancel (Cross-Scope IIFE Variable Bug)
* **Symptom**: When a transfer is cancelled mid-flight, both sender and receiver particle animations stay stuck in a loop and the progress UI never resets.
* **Root Cause**: `onTransferCancelled()` in Chapter 3's IIFE referenced `rxRafId`, `rxTransferActive`, `rxProgress`, `rxSpeed` directly, but these are declared in Chapter 4's IIFE. JS silently created implicit globals instead of modifying the real IIFE-scoped variables, so the real receiver animation frame was never cancelled.
* **Fix**: Exposed `window.stopReceiverAnimation()` from Chapter 4's IIFE to properly cancel receiver animations. `onTransferCancelled()` now calls this instead of referencing cross-scope variables. Also hoisted `animRaf` to IIFE-scoped `incomingSphereRafId` for external cancellation.

---

## 9. Sender Repeller Particle Symmetry
* **Symptom**: Sender's outward-shooting particles were too fast and too dense compared to the receiver's inward-converging particles, breaking visual symmetry.
* **Root Cause**: Repeller reset speed was `1.5 + Math.random() * 1.0` (1.5–2.5 units/frame) — 5-9× faster than the attractor's reset speed of `(Math.random()-.5)*.4` (~0–0.28 units/frame). The attractor lets its force do the gradual acceleration; the repeller was launching at terminal velocity.
* **Fix**: Fine-tuned the repeller particle dynamics for a smooth, symmetric visual feel:
  1. **All Particles Active**: Restored 100% of particles to the outward repelling animation (no subset filter).
  2. **Fade-In on Reset**: Set `this.alpha = 0.25` on center reset and added a `0.014` additional fade-in increment per frame (for a total of `0.02` per frame). This makes the particles reach full opacity in ~0.6 seconds, resolving the "too dim" symptom while maintaining smooth entry without visual popping.
  3. **Tuned Pacing**: Decreased the repelling force multiplier to `0.008` (from the original `0.012`) and center reset speed to `0.2` (from the original `0.4`) for smoother, gentler acceleration.

---

## 10. Sender Particles Moving Inward (Gravity Well Operation Order Bug)
* **Symptom**: Sender's repeller particles move inward (attractor behavior) instead of outward during send animation.
* **Root Cause**: In the grab handler, `setGravityWell(isRepeller=true)` was called BEFORE `stopGravityWellIdle()`. Since `stopGravityWellIdle()` calls `clearGravityWell()` which sets `gravWell=null`, it immediately wiped the repeller state. When `startGravityWellIdle()` then ran its first `oscillate()` frame, `isRepeller()` read `null` → returned `false` → set attractor mode permanently.
* **Fix**: Reordered to **stop → set → start**: stop the old loop (clears gravWell), then set the repeller well (gravWell.isRepeller=true), then start the new oscillation loop (reads the fresh repeller state).

---

## 11. Symmetrical Files Drawer Toggle Visibility & Transition Overlaps
* **Symptom**: Transitioning from sender to receiver screen left elements overlapping or in incorrect visual states, and the files drawer toggle button disappeared/reset inconsistently when changing roles even if files existed.
* **Root Cause**: 
  1. `transitionToReceiver` mistakenly targeted and hid the `receiver-screen` instead of the `sender-screen`.
  2. Manual `visible` class overrides on `#files-panel-toggle` (such as in `transitionToSender`, `leaveReceiver`, and `initReceiverMode`) did not check the actual received file count.
* **Fix**:
  1. Restored the `sender-screen` hide logic inside `transitionToReceiver`.
  2. Exposed `updatePanelToggle` as a global function (`window.updatePanelToggle`) so all modules can access it.
  3. Replaced manual visibility overrides with symmetric `window.updatePanelToggle?.()` calls in transitions, dynamically verifying the received file buffer count (`rxFiles.length > 0`) before adding or removing the `visible` class.

---

## 12. Chopped Mobile Logo (Notch Safe-Area Overlaps)
* **Symptom**: On mobile devices (particularly iOS and Android notch devices), the top logo is chopped or cut off from above.
* **Root Cause**: `#top-bar` used absolute `top: 0` positioning and a fixed `56px` height without accounting for browser safe-area insets, allowing physical status bars to cover the header logo.
* **Fix**: Updated `#top-bar` styling in `index.html` to dynamically calculate height and padding using CSS env variables (`env(safe-area-inset-top, 0px)`).

---

## 13. Dynamic Multi-File Progress Labels ("File X of Y")
* **Symptom**: When transferring multiple files, the progress label remained stuck on `"File 1 of N"` on both the sender and receiver screens.
* **Root Cause**: The progress callbacks (`updateSenderProgress` and `updateReceiverProgress`) did not receive the current file index and total count parameters, leaving the text elements static.
* **Fix**:
  - Updated `updateSenderProgress` and `updateReceiverProgress` in `index.html` to accept `batchIndex` and `batchCount` arguments and update progress text elements dynamically.
  - Passed these parameters from `src/App.tsx` during progress ticks and metadata arrivals.

---

## 14. Empty Received Files List Panel (escapeHTML Closure ReferenceError)
* **Symptom**: Received files do not display in the files list panel, even though the total count is correct and the "Download All" action still works.
* **Root Cause**: `renderFilesPanel()` (defined in Chapter 4 IIFE) calls `escapeHTML()` to sanitize filenames. However, `escapeHTML()` was defined as a local function in Chapter 3's IIFE, throwing a silent `ReferenceError` that halted list generation.
* **Fix**: Defined a local `escapeHTML` helper function directly inside Chapter 4's IIFE scope in `index.html`.

---

## 15. Sender Stuck Loop & Receiver Early Exit
* **Symptom**: During a multi-file transfer, only n-1 files are transferred successfully, the receiver exits to the success screen early, and the sender stays stuck in the sending loop permanently. On refresh, the receiver re-encounters the remaining unsent files.
* **Root Cause**: `incomingFileRef.current` was set to `null` too early inside `handleEngineComplete` in `src/App.tsx`. When callbacks fired, the receiver evaluated `batchCount` as `undefined` (defaulting to `1`), concluding the first file was the final file, exiting the loop, and hanging the sender.
* **Fix**: Cached metadata parameters early in `handleEngineComplete` before nulling `incomingFileRef.current`.

---

## 16. Multiple Directory Picker Prompts on Receiver
* **Symptom**: When transferring a batch of 10 files, the user is prompted to choose a directory 10 times on the receiving laptop.
* **Root Cause**: `showDirectoryPicker()` is asynchronous. Since multiple files complete their transfer before the user completes the folder selection for the first file, each file initiates its own directory prompt concurrently.
* **Fix**: Implemented `isChoosingDirectoryRef` in `saveFileAsync` in `src/App.tsx`. Subsequent files check the flag and wait for the directory picker selection to complete before proceeding, allowing them to reuse the resolved handle.

---

## 17. Receiver Backup Warning Notification
* **Symptom**: Users are unaware that received files are backed up in the files panel if the automatic download fails.
* **Fix**: Added a secondary toast notification at the end of receiver completion instructing users they can download files from the files panel backup.

---

## 18. Pre-Initialization Room Joining
* **Symptom**: Users joining or creating a room immediately upon slow network page loads bypass the socket initialization flow, leading to broken workspace screens.
* **Root Cause**: Clicking Join/Create before React loads and binds `_socketJoinRoom` / `_socketCreateRoom` to the window falls back to mock picker menus.
* **Fix**: Checked `document.readyState` and socket helper bindings at the start of click handlers, blocking actions with a loading notice if the system is still initializing.

---
