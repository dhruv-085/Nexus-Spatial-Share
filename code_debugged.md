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

## 19. Sender Stuck in Animation Loop on Completion
* **Symptom**: After a complete file transfer, the sender stays in the repelling animation loop, whereas cancelling stops it correctly.
* **Root Cause**: `completeTransfer()` did not immediately release particle system states or clear the gravity well. Furthermore, `explodeSphere` did not clear the gravity well.
* **Fix**: Reset `gravWell = null` immediately inside `explodeSphere`, and called `ParticleSystem.clearGravityWell()` and `releaseAll()` immediately in `completeTransfer()`.

---

## 20. Missing Speed/ETA Metrics on Receiver Progress Screen
* **Symptom**: Receiver progress panel shows no Speed or ETA metrics during chunks transfer, displaying only '— Receiving…'.
* **Root Cause**: The speed metric was only updated if `speedMbps > 0`. Because the telemetry calculation ticks once every 1 second, short transfers (or the first second of a long transfer) had `speedMbps = 0` which resulted in blank telemetry values. Also, the `rxMeta` object was bound late through a runtime wrapper override.
* **Fix**: Declared and assigned `rxMeta` directly inside `triggerIncomingSphere`, and updated `updateReceiverProgress` to gracefully default to `0.0 MB/s · —` when speed is not yet positive, keeping metrics visible.

---

## 21. Stale File Selection in Sender Queue
* **Symptom**: When a previous transfer completes and the user attempts to select and send a new file, the old files from the previous batch still appear selected by default.
* **Root Cause**: `fileQueue` in `index.html` was not cleared when the transfer completed or when the sender UI reset.
* **Fix**: Cleared `fileQueue = []`, reset the file input element, and triggered `onFilesSelected([])` to sync React state inside `resetSenderUI()`.

---

## 22. Multiple File Location Dialogs on Desktop Receiver
* **Symptom**: When receiving a batch of files on a desktop browser, the browser file save location dialog pops up for every single file in the batch.
* **Root Cause**: When the receiver clicked "Drop", `handleDropAction()` used `showSaveFilePicker` for the first file, leaving `saveDirectoryHandleRef` null. As subsequent files in the batch arrived, they fallback to browser download triggers, prompting the user for each file if the browser settings are configured to ask.
* **Fix**: Preferred `showDirectoryPicker()` in `handleDropAction()` so the user selects a target directory once for the entire batch. Integrated `directoryPickerDeclinedRef` to skip prompts and download all files automatically if they cancel the picker.

---

## 23. Chopped Logo on Mobile Viewports (Notch Overlaps)
* **Symptom**: On mobile phone viewports, the top logo icon and text are cropped or chopped from above.
* **Root Cause**: The viewport metadata did not support `viewport-fit=cover`, resulting in `env(safe-area-inset-top)` evaluating to `0px`. Also, spacing constraints on mobile squished the top-bar height.
* **Fix**: Added `viewport-fit=cover` to the viewport `<meta>` tag, and configured the mobile media queries to increase `#top-bar` height and shift screen layouts down safely.

---

## 24. OTP Room Code Focus Stale State After Clear & Retype
* **Symptom**: Clearing all 4 room code boxes via Backspace and retyping caused cursor auto-advance to fail on subsequent boxes.
* **Root Cause**: Reliance on browser native `input` events when input selection state was reset mid-clear.
* **Fix**: Intercepted numeric keys `[0-9]` directly in the `keydown` event listener, calling `preventDefault()`, updating state synchronously, and explicitly calling `.focus()` on the next input box.

---

## 25. Sender Particle Animation Stuck After Successful Transfer
* **Symptom**: After a successful transfer, the sender's particle animation remained stuck at sphere positions.
* **Root Cause**: `completeTransfer()` called `releaseAll()` BEFORE `explodeSphere()`, clearing particle sphere targets so the explosion had no source positions to burst from.
* **Fix**: Reordered `completeTransfer()` to cancel RAF, stop gravity well idle, clear attractor, hide progress UI, burst particles via `explodeSphere()`, and only call `releaseAll()` inside the explosion completion callback.

---

## 26. Receiver Progress Ring Not Displaying on Subsequent Transfers
* **Symptom**: Receiver progress ring stopped appearing after prior successful or cancelled transfers, and occasionally overlapped with the gravity well UI.
* **Root Cause**: `rxTransferActive` was not reset if previous completion handlers encountered errors or unhandled edge cases, causing `startReceive` guard `if (rxTransferActive) return;` to block future progress rings. Also, SVG `strokeDashoffset` was not reset to 502 at the start of new transfers.
* **Fix**: Explicitly reset `rxTransferActive = false` inside `triggerIncomingSphere()`, reset SVG `strokeDashoffset` to 502 and percent text to 0 in `showReceiveProgress()`, explicitly hid `gravity-well-ui`, and wrapped `completeReceive()` in `try/catch/finally`.

---

## 27. Unified Batch File Download Prompt Strategy
* **Symptom**: Desktop receivers were prompted for file save locations per-file during batch transfers, or pickers were bypassable causing duplicate prompts.
* **Root Cause**: Dual-method handling between button drop and gesture drop created separate picker paths (`showSaveFilePicker` vs OPFS), causing per-file prompts.
* **Fix**: Removed per-file pickers entirely. `saveFileAsync()` prompts `showDirectoryPicker()` **ONCE** for the first received file. All subsequent files in the batch automatically save to that handle or fall back to silent browser auto-downloads via an `<a>` element.

---

## 28. Mobile Background/Minimize Disconnect Mitigation
* **Symptom**: On mobile devices, taking time in the file picker caused server disconnects, and backgrounding/minimizing the browser interrupted active transfers.
* **Root Cause**: Aggressive mobile OS webview background suspension froze Socket.IO keepalives and WebRTC channels.
* **Fix**: 
  1. Triggered silent background audio on file-input click (before file selection).
  2. Tuned Socket.IO keepalive timeouts (`pingTimeout: 120000`, `pingInterval: 15000` on server; `reconnectionDelay`, `timeout` on client).
  3. Added `visibilitychange` listener in `App.tsx` to detect resume, force socket reconnection, re-emit `join-room`, and re-acquire screen WakeLock.
  4. Added informative mobile toast guiding users to keep the app in foreground during active transfers.

---

## 29. OTP Auto-Advance, Globe Render on Load & Join Button Response
* **Symptom**: Typing digits into OTP boxes failed to auto-advance to subsequent boxes, network globe was invisible on page load, and Join Room button showed loading message indefinitely.
* **Root Cause**: 
  1. Intercepting `keydown` for `0-9` with `preventDefault()` blocked native character input and native `input` event dispatching, breaking soft/virtual keyboards and focus transitions.
  2. `drawGlobe()` animation loop was never kicked off on initial page load until an OTP node was explicitly activated.
  3. `joinRoom()` checked `document.readyState !== 'complete'`, which blocked room joining if background resources (fonts/images) were still loading even though DOM and React socket handlers were ready.
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

## 19. Sender Stuck in Animation Loop on Completion
* **Symptom**: After a complete file transfer, the sender stays in the repelling animation loop, whereas cancelling stops it correctly.
* **Root Cause**: `completeTransfer()` did not immediately release particle system states or clear the gravity well. Furthermore, `explodeSphere` did not clear the gravity well.
* **Fix**: Reset `gravWell = null` immediately inside `explodeSphere`, and called `ParticleSystem.clearGravityWell()` and `releaseAll()` immediately in `completeTransfer()`.

---

## 20. Missing Speed/ETA Metrics on Receiver Progress Screen
* **Symptom**: Receiver progress panel shows no Speed or ETA metrics during chunks transfer, displaying only '— Receiving…'.
* **Root Cause**: The speed metric was only updated if `speedMbps > 0`. Because the telemetry calculation ticks once every 1 second, short transfers (or the first second of a long transfer) had `speedMbps = 0` which resulted in blank telemetry values. Also, the `rxMeta` object was bound late through a runtime wrapper override.
* **Fix**: Declared and assigned `rxMeta` directly inside `triggerIncomingSphere`, and updated `updateReceiverProgress` to gracefully default to `0.0 MB/s · —` when speed is not yet positive, keeping metrics visible.

---

## 21. Stale File Selection in Sender Queue
* **Symptom**: When a previous transfer completes and the user attempts to select and send a new file, the old files from the previous batch still appear selected by default.
* **Root Cause**: `fileQueue` in `index.html` was not cleared when the transfer completed or when the sender UI reset.
* **Fix**: Cleared `fileQueue = []`, reset the file input element, and triggered `onFilesSelected([])` to sync React state inside `resetSenderUI()`.

---

## 22. Multiple File Location Dialogs on Desktop Receiver
* **Symptom**: When receiving a batch of files on a desktop browser, the browser file save location dialog pops up for every single file in the batch.
* **Root Cause**: When the receiver clicked "Drop", `handleDropAction()` used `showSaveFilePicker` for the first file, leaving `saveDirectoryHandleRef` null. As subsequent files in the batch arrived, they fallback to browser download triggers, prompting the user for each file if the browser settings are configured to ask.
* **Fix**: Preferred `showDirectoryPicker()` in `handleDropAction()` so the user selects a target directory once for the entire batch. Integrated `directoryPickerDeclinedRef` to skip prompts and download all files automatically if they cancel the picker.

---

## 23. Chopped Logo on Mobile Viewports (Notch Overlaps)
* **Symptom**: On mobile phone viewports, the top logo icon and text are cropped or chopped from above.
* **Root Cause**: The viewport metadata did not support `viewport-fit=cover`, resulting in `env(safe-area-inset-top)` evaluating to `0px`. Also, spacing constraints on mobile squished the top-bar height.
* **Fix**: Added `viewport-fit=cover` to the viewport `<meta>` tag, and configured the mobile media queries to increase `#top-bar` height and shift screen layouts down safely.

---

## 24. OTP Room Code Focus Stale State After Clear & Retype
* **Symptom**: Clearing all 4 room code boxes via Backspace and retyping caused cursor auto-advance to fail on subsequent boxes.
* **Root Cause**: Reliance on browser native `input` events when input selection state was reset mid-clear.
* **Fix**: Intercepted numeric keys `[0-9]` directly in the `keydown` event listener, calling `preventDefault()`, updating state synchronously, and explicitly calling `.focus()` on the next input box.

---

## 25. Sender Particle Animation Stuck After Successful Transfer
* **Symptom**: After a successful transfer, the sender's particle animation remained stuck at sphere positions.
* **Root Cause**: `completeTransfer()` called `releaseAll()` BEFORE `explodeSphere()`, clearing particle sphere targets so the explosion had no source positions to burst from.
* **Fix**: Reordered `completeTransfer()` to cancel RAF, stop gravity well idle, clear attractor, hide progress UI, burst particles via `explodeSphere()`, and only call `releaseAll()` inside the explosion completion callback.

---

## 26. Receiver Progress Ring Not Displaying on Subsequent Transfers
* **Symptom**: Receiver progress ring stopped appearing after prior successful or cancelled transfers, and occasionally overlapped with the gravity well UI.
* **Root Cause**: `rxTransferActive` was not reset if previous completion handlers encountered errors or unhandled edge cases, causing `startReceive` guard `if (rxTransferActive) return;` to block future progress rings. Also, SVG `strokeDashoffset` was not reset to 502 at the start of new transfers.
* **Fix**: Explicitly reset `rxTransferActive = false` inside `triggerIncomingSphere()`, reset SVG `strokeDashoffset` to 502 and percent text to 0 in `showReceiveProgress()`, explicitly hid `gravity-well-ui`, and wrapped `completeReceive()` in `try/catch/finally`.

---

## 27. Unified Batch File Download Prompt Strategy
* **Symptom**: Desktop receivers were prompted for file save locations per-file during batch transfers, or pickers were bypassable causing duplicate prompts.
* **Root Cause**: Dual-method handling between button drop and gesture drop created separate picker paths (`showSaveFilePicker` vs OPFS), causing per-file prompts.
* **Fix**: Removed per-file pickers entirely. `saveFileAsync()` prompts `showDirectoryPicker()` **ONCE** for the first received file. All subsequent files in the batch automatically save to that handle or fall back to silent browser auto-downloads via an `<a>` element.

---

## 28. Mobile Background/Minimize Disconnect Mitigation
* **Symptom**: On mobile devices, taking time in the file picker caused server disconnects, and backgrounding/minimizing the browser interrupted active transfers.
* **Root Cause**: Aggressive mobile OS webview background suspension froze Socket.IO keepalives and WebRTC channels.
* **Fix**: 
  1. Triggered silent background audio on file-input click (before file selection).
  2. Tuned Socket.IO keepalive timeouts (`pingTimeout: 120000`, `pingInterval: 15000` on server; `reconnectionDelay`, `timeout` on client).
  3. Added `visibilitychange` listener in `App.tsx` to detect resume, force socket reconnection, re-emit `join-room`, and re-acquire screen WakeLock.
  4. Added informative mobile toast guiding users to keep the app in foreground during active transfers.

---

## 29. OTP Auto-Advance, Globe Render on Load & Join Button Response
* **Symptom**: Typing digits into OTP boxes failed to auto-advance to subsequent boxes, network globe was invisible on page load, and Join Room button showed loading message indefinitely.
* **Root Cause**: 
  1. Intercepting `keydown` for `0-9` with `preventDefault()` blocked native character input and native `input` event dispatching, breaking soft/virtual keyboards and focus transitions.
  2. `drawGlobe()` animation loop was never kicked off on initial page load until an OTP node was explicitly activated.
  3. `joinRoom()` checked `document.readyState !== 'complete'`, which blocked room joining if background resources (fonts/images) were still loading even though DOM and React socket handlers were ready.
* **Fix**: 
  1. Restored native `input` event handling for OTP digit entry (extracting latest digit), using `keydown` strictly for `Backspace`/`Delete`/`Arrow` navigation.
  2. Injected `kick()` call at the end of Chapter 2 IIFE to start the 3D globe animation loop immediately on page load.
  3. Changed readiness check in `joinRoom()` and `btn-create` to `document.readyState === 'loading'`, allowing instant joining as soon as DOM scripts parse and React binds socket handlers.

---

## 30. HTML Script Tag Parsing Failure (TypeScript Cast Syntax Error)
* **Symptom**: Page load failed to initialize any UI or script features — the signaling status pill remained grey/off, Toast notifications didn't pop, Join/Create buttons didn't respond, 3D globe was invisible, and OTP digit auto-advance did not function.
* **Root Cause**: A TypeScript type assertion (`(window as any)`) was accidentally included in a plain JavaScript `<script>` tag in `index.html` during mobile background audio event setup (line 2568), throwing a fatal `Uncaught SyntaxError: Unexpected identifier 'as'` at browser parse time that halted execution of all subsequent scripts.
* **Fix**: Replaced `(window as any)` with plain JavaScript `window` in `index.html`. Verified all script tags parse without errors using Node JS syntax checks.

---

---

## 33. OTP Single-Digit Backspace & Auto-Drop on FILE_META Arrival
* **Symptom**: 
  1. Pressing Backspace in an OTP box cleared the current box AND shifted focus to the previous box in a single keypress, causing Backspace to erase 2 boxes at once.
  2. Clicking Drop on laptop when mobile sent files sent `REQUEST_FILE_META`, but when `FILE_META` arrived, the laptop did not automatically initiate the drop action.
* **Root Cause**: 
  1. `keydown` Backspace handler contained `if (i > 0) { boxes[i-1].focus(); }` inside the `digits_state[i] !== ''` branch, shifting focus to the previous input during the active keydown event.
  2. `handleDropAction()` returned early on missing metadata without registering an auto-trigger listener to re-run `handleDropAction()` when `FILE_META` arrived.
* **Fix**: 
  1. Updated Backspace handler in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2255-L2265) so Backspace on a filled box clears ONLY that box and stays in place. Focus moves to the previous box only when Backspace is pressed on an empty box.
  2. Added `pendingDropActionRef` and an auto-trigger block inside `FILE_META` handler in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1425) to automatically execute `handleDropAction()` as soon as `FILE_META` arrives.

---

## 34. OTP Traversal Focus Sync
* **Symptom**: Clearing room code digits and re-entering digits caused focus auto-advance to stall or get trapped in box 4.
* **Root Cause**: Desynchronized focus selection handling on input boxes during rapid re-entry.
* **Fix**: Refactored `keydown`, `input`, and `focus` event handlers in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2254-L2294) to cleanly shift focus backward/forward with `try { select() }` guards.

---

## 35. Premature Auto-Transfer Execution & Camera Permission Decoupling
* **Symptom**: Sender clicking Grab/Send immediately started transfer on receiver without receiver clicking Drop or performing a gesture, and denying camera permission disabled `#btn-drop`.
* **Root Cause**: `FILE_META` handler in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1425) contained an automatic fallback `(isGlobalLockedRef.current && !isSourceRef.current && !transferRequestedRef.current)` that executed `handleDropAction()` without user input.
* **Fix**: Removed passive auto-execution condition from `src/App.tsx`. Decoupled `#btn-drop` button availability from webcam permission states.

---

## 36. Symmetrical Telemetry Speed & ETA Calculations
* **Symptom**: Sender and Receiver progress panels displayed inconsistent ETAs and speed metrics during multi-file transfers.
* **Root Cause**: `updateSenderProgress` calculated remaining bytes using `totalBatchBytes * (1 - progress)`, whereas `updateReceiverProgress` used `singleFileBytes * (1 - progress)`.
* **Fix**: Updated `updateSenderProgress` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2664-L2668) to calculate remaining bytes using `activeFile.size * (1 - progress)`, aligning readouts on both ends.

---

## 37. Sender Transfer Completion Auto-Dismiss
* **Symptom**: After a transfer completed, the receiver returned to normal idle state while the sender remained locked on the success modal.
* **Root Cause**: `completeTransfer()` displayed `#success-screen` but lacked an auto-dismiss lifecycle timer.
* **Fix**: Added a 6-second `setTimeout` inside `completeTransfer()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2706-L2711) to automatically invoke `sendAnotherFile()`, clearing gravity wells, particle repellers, and returning sender UI back to normal idle state.

---

---

## 39. OTP Digit Backspace Traversal & Re-entry Focus Fix
* **Symptom**: Once a user entered all 4 room code digits and attempted to erase a mistake using Backspace, the focus immediately jumped backward to the previous box while erasing the current box, causing subsequent typed digits to overwrite the wrong box.
* **Root Cause**: The `Backspace` keydown listener in `index.html` contained `if (i > 0) { boxes[i-1].focus(); }` inside the `digits_state[i] !== ''` branch, shifting focus backward on every backspace press even when the target box was filled.
* **Fix**: Updated `index.html` so backspacing a filled box clears ONLY that box (`setDigit(i, '')`) and maintains focus on box `i`. Focus shifts backward to `boxes[i-1]` ONLY when Backspace is pressed on an already-empty box (`digits_state[i] === ''`).

---

## 40. Background Canvas Animation Masking, Missing ETA/Cancel UI & Foreground Transfer Resume
* **Symptom**: 
  1. Selecting a file and clicking Send hid the entire 3D background particle canvas and sending particle repeller animation.
  2. Telemetry speed and ETA displayed missing or empty strings (`—`) during initial transfer ticks.
  3. Cancel transfer button `#btn-cancel` / `#btn-rx-cancel` remained hidden on new transfers if previously toggled.
  4. Minimizing or backgrounding the browser on mobile/desktop interrupted transfers without auto-resuming on return.
* **Root Cause**: 
  1. `#progress-screen` and `#receive-progress` contained opaque background styling `background: rgba(10, 10, 10, 0.88)` and `backdrop-filter: blur(20px)` covering `inset: 0` at `z-index: 25`, masking out `#nexus-canvas` (`z-index: 0`).
  2. Cancel button elements retained `style.display = 'none'` after cancel modal confirmations without being reset during progress screen initialization.
  3. `updateSenderProgress` and `updateReceiverProgress` did not provide fallback strings when `speedMbps` was 0.
  4. App visibility handler did not trigger `START_TRANSFER` with `resumeManifest` upon returning to foreground during active transfers.
* **Fix**: 
  1. Changed `#progress-screen` and `#receive-progress` container backgrounds to `transparent` and `backdrop-filter: none`, setting `pointer-events: none` on container overlays and `pointer-events: auto` on interactive UI cards, exposing the background particle canvas and physics animations.
  2. Explicitly reset cancel buttons (`#btn-cancel` & `#btn-rx-cancel`) to `style.display = ''` and hid confirmation dialogs whenever progress screens open.
  3. Formatted ETA output cleanly with fallbacks (`0.0 MB/s · Calculating...` and `~Xs remaining`).

---

## 41. OTP Traversal, Drop Zone Click Pointer Scoping, WebRTC P2P Race & CPU Animation Cleanup
* **Symptom**:
  1. **OTP Traversal**: Erasing digits in filled room code boxes did not immediately move focus backward to the previous box on mobile or desktop keyboards.
  2. **Drop Zone Hitbox**: The central region of `#drop-zone` was unclickable, responding to file select clicks only on its outermost edges.
  3. **Transfer Race Condition**: Clicking Send showed progress UI but transfer stayed at `0.0 MB/s · Calculating...` or receiver remained at `waiting for transfer` when data channels were still connecting.
  4. **Stuck Animation Loop on Disconnect**: Peer disconnection or WebRTC ICE failure mid-transfer left the sender/receiver looping in transfer state animations without displaying an error modal.
  5. **High CPU Utilization**: Background tabs and idle screens consumed high CPU due to unthrottled `requestAnimationFrame` particle and globe render loops.
* **Root Cause**:
  1. OTP `keydown` and `input` listeners did not advance focus to `boxes[i-1]` on backspacing a filled digit box, requiring a second keypress. Android virtual keyboards also failed to trigger standard keydown events for backspace without `beforeinput` fallback.
  2. `#progress-screen > *` and `#receive-progress > *` CSS rules applied `pointer-events: auto` to direct children at `z-index: 25` even when container `opacity` was 0, capturing clicks in the center of `#drop-zone` (`z-index: 10`).
  3. `executeTransfer` and `FILE_META` dispatch bailed out if data/control channels were still connecting (`readyState !== 'open'`) when `START_TRANSFER` or Grab arrived, without queuing them for dispatch upon channel open.
  4. `pc.oniceconnectionstatechange` `'failed'` and `dc.onclose` did not invoke `cancelTransfer()` or `(window as any).showPeerDisconnected?.(true)`, leaving UI refs (`isTransferringRef`) set to true.
  5. `loop()`, `drawGlobe()`, and `lerpSphereToTouch()` ran `requestAnimationFrame` continuously even when `document.visibilityState === 'hidden'` or when nodes were idle.
* **Fix**:
  1. Updated OTP `keydown`, `beforeinput`, and `input` listeners in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2274-L2305) to immediately erase and shift focus to `boxes[i-1]` on backspace, and support multi-character composition for mobile IMEs.
  2. Scoped `#progress-screen.visible > *` and `#receive-progress.visible > *` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L613-L614) so children only capture pointer events when screen is `.visible`.
  3. Added `pendingStartTransferRef` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L75) to queue transfer execution while WebRTC channels finish opening, automatically flushing when `handleOpen` fires.
  4. Added `cancelTransfer()` and `(window as any).showPeerDisconnected?.(true)` calls in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1200-L1345) for ICE failures and mid-transfer channel closures.
  5. Added `document.visibilityState === 'hidden'` checks to `loop()`, `drawGlobe()`, and `lerpSphereToTouch()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2106-L2160) to eliminate CPU usage when tab is hidden or idle.

---

## 42. Calm Water Ripple Radiating Rings, Viewport Centered ETA Rings & OTP Graph De-duplication
* **Symptom**:
  1. Radiating rings (`TransferRings`) during transfers were too fast, bright, and distracting.
  2. The progress ring (`.progress-ring-wrap`) was offset ~57px above the viewport vertical midpoint on progress screens due to asymmetrical header/footer flex heights.
  3. Repeatedly re-typing or pressing room code OTP boxes caused duplicate connection lines to accumulate in `activeEdgeProgress` on the 3D network globe.
* **Root Cause**:
  1. `TransferRings` used short lifetimes (`1400ms`), fast spawn intervals (`700ms`), cubic ease-out curves, and high peak alpha (`0.45`).
  2. `#progress-screen` and `#receive-progress` used `justify-content: center` over all children without separating top labels and bottom cards into symmetrical flex flex-1 containers.
  3. `activateNode(slot, digitChar)` unconditionally pushed new edge objects to `activeEdgeProgress` without checking if an edge between the node pair already existed or if the node for that slot was already active.
* **Fix**:
  1. Retuned `TransferRings` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2472-L2605): `LIFE_MS = 3400`, `SPAWN_MS = 1350`, `TRAVEL_PX = 240`, `PEAK_ALPHA = 0.16`, with quadratic ease-out (`out`) and sine ease-in (`in`) easing curves for calm, subtle water ripples.
  2. Structured `#progress-screen` and `#receive-progress` into a 3-stage flex container (`.progress-top-region`, `.progress-ring-wrap`, `.progress-bottom-region`) in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L591-L610), locking `.progress-ring-wrap` exactly at `50vh` across all viewports.
  3. Refactored `activateNode` and `deactivateNode` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2140-L2175) to validate edge uniqueness (`!exists`) and return early on same-node re-activation, and updated `resetGlobe()` to flush all globe and OTP state. Extended Playwright test suite [test_otp.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_otp.cjs) with 38/38 passing checks.

---

## 43. Signaling Server Connection Failure on Local Network IP & Non-Standard Dev Ports
* **Symptom**:
  1. The bottom bar "Signaling Server" dot remained red/amber and failed to turn green when accessing the application from mobile devices or other devices on the local Wi-Fi / LAN network.
  2. The home screen status pill stayed at "Not Connected", and attempting to create or join a room failed or hung with "Connecting to signaling server... please wait".
* **Root Cause**:
  1. `SERVER_URL` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L225-L230) was hardcoded to check `window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'` to append port `:3000`. When accessed via a local network IP (e.g., `192.168.x.x:5173`), `hostname` was an IP address, so it fell back to `${window.location.protocol}//${window.location.host}` (`192.168.x.x:5173`). Because Express/Socket.IO runs on port `3000`, the socket connection to port `5173` failed with a `connect_error`.
  2. `Signaling.onConnect()` and `onDisconnect()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L3967-L3985) relied strictly on a closure-cached reference `dotSignaling` created at script load, which could miss updating if DOM elements re-mounted or initialized asynchronously.
* **Fix**:
  1. Refactored `SERVER_URL` calculation in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L225-L230) to check whether `window.location.port` is a non-standard dev port (not `3000`, empty, `80`, or `443`). Whenever running on a dev port (e.g. Vite on 5173), `SERVER_URL` automatically targets port `:3000` on `window.location.hostname` across both localhost and local network IP addresses.
  2. Updated `Signaling.onConnect()` and `Signaling.onDisconnect()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L3967-L3985) to dynamically retrieve `document.getElementById('dot-signaling')` and `document.getElementById('dot-webrtc')` at call time, ensuring class transitions (`green` / `amber`) always take effect.

---

## 44. Room Joining Stale Error Text Persistence & Socket Transport Resilience
* **Symptom**:
  1. Clicking "Join Room" or "Create Room" displayed "Please wait, the website is still loading..." or "Connecting to signaling server... please wait." in `#join-error`, and the message remained stuck on screen even after the socket connected and the signaling server dot turned green.
  2. Users were unable to tell if room joining succeeded because the error message persisted under the room code inputs.
* **Root Cause**:
  1. When room joining was attempted before React mounted or while socket connection was negotiating, `joinRoom()` set `#join-error` text. When `socket.on("connect")` and `Signaling.onConnect()` fired, no handler ever cleared `#join-error`, leaving the stale loading/connecting text permanently rendered.
  2. Socket.IO client initialization lacked explicit `transports: ['websocket', 'polling']`, causing potential fallback delays in certain network environments.
* **Fix**:
  1. Updated `Signaling.onConnect()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L3967-L3980) and `socket.on("connect")` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L246-L255) to automatically check and clear any lingering `"loading"` or `"signaling"` error string from `#join-error` upon connection.
  2. Updated `_socketJoinRoom`, `_socketCreateRoom`, and `App.tsx` mount hooks to clear stale loading messages when room actions are initiated or when React mounts.
  3. Added explicit `transports: ['websocket', 'polling']` to `io()` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L230-L237).

---

## 45. Vite Dev Middleware Ordering, React Refresh Preamble & Module MIME Type Fix
* **Symptom**:
  1. Bottom-bar "Signaling Server" dot remained grey/off and failed to turn green.
  2. Status pill remained at "Not Connected".
  3. Clicking "Join Room" or "Create Room" displayed "Please wait, the website is still loading..." indefinitely.
  4. Browser console reported `Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`.
* **Root Cause**:
  1. In `server.ts`, the wildcard HTML route `app.get('*')` was mounted *before* `app.use(vite.middlewares)` with a brittle regex (`/\.(js|css|...)$/`) that failed on dependency URLs with query parameters (e.g. `/node_modules/.vite/deps/react.js?v=...`) and `/node_modules/` paths, serving `index.html` as `text/html` instead of JavaScript.
  2. Strict MIME checking blocked browser module loading, preventing React `<App />` from mounting, which meant `window._socketJoinRoom` / `window._socketCreateRoom` were never defined and the Socket.IO client was never started.
  3. `@vitejs/plugin-react` threw a preamble detection error in custom SSR/middleware mode when `$RefreshReg$` and `$RefreshSig$` were not initialized synchronously before module evaluation.
* **Fix**:
  1. Reordered `server.ts` dev server setup: set `appType: "custom"`, mounted `app.use(vite.middlewares)` FIRST so Vite intercepts and serves all module/dependency requests with proper JS MIME types, and configured `hmr: { server: httpServer }` to reuse the HTTPS server.
  2. Attached fallback `app.use('*')` to transform and serve `index.html` for non-module document requests.
  3. Added synchronous `$RefreshReg$` and `$RefreshSig$` initialization in `<head>` of [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L82-L86) and [src/main.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/main.tsx#L12-L18).
  4. Validated with automated Playwright browser test suites ([test_otp.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_otp.cjs) 38/38 passed, two-peer signaling negotiation verified).

---

## 46. OPFS Storage Accumulation & Temp File Leak on Cancellation & Session Reset
* **Symptom**:
  1. Cancelling transfers mid-flight on mobile devices or browsers using OPFS caused storage to accumulate continuously on the device.
  2. Reloading the page or closing the room left stranded multi-megabyte temporary files in OPFS (`navigator.storage.getDirectory()`).
  3. Memory and disk cache accumulated unrevoked Blob URLs over time.
* **Root Cause**:
  1. **Async Stream Writer Lock Race Condition**: In `TransferEngine.cancel()`, `streamWriter.close()` was executed in the background without awaiting resolution. Concurrently, `App.tsx` attempted `root.removeEntry(nameToDelete)`. Because the file lock was still held by the active `FileSystemWritableFileStream`, `removeEntry()` threw a locked file error which was caught silently, leaving partial files stranded.
  2. **Missing Startup & Session Sanitization**: The app lacked startup and room-leave passes to clean up leftover or orphaned files from prior sessions or abrupt tab closures.
  3. **Unrevoked Blob URLs**: Blob URLs created during file viewing and saving were not centrally tracked or revoked upon clearing files or leaving rooms.
* **Fix**:
  1. Upgraded [src/lib/TransferEngine.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/lib/TransferEngine.ts) with `closeStreamWriterAsync()` to properly abort or close `streamWriter` with timeout protection and await lock release.
  2. Implemented `purgePartialTransferFileAsync` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) with awaitable stream release, immediate `removeEntry()`, and a `truncate(0)` zero-out fallback for guaranteed deletion across all storage paths.
  3. Added `sanitizeOpfsStorage(keepNames)` and `blobUrlRegistryRef` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) invoked on app mount, room leave (`_socketLeaveRoom`, `leaveRoom`), and clear files (`btn-clear-files`), with automatic Blob URL revocation.
  4. Created comprehensive test suite [test_opfs_storage_cleanup.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_opfs_storage_cleanup.cjs) (4/4 tests passed) and verified zero regressions across [test_exit_paths.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_exit_paths.cjs) (21/21 passed) and [test_otp.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_otp.cjs) (38/38 passed).

---

## 47. Comprehensive Error Pages, System Error Boundaries & Full-Stack Security Hardening
* **Symptom**:
  1. Unmatched HTTP web routes or `/api/*` endpoints returned default Express text or unhandled exceptions without branded UI or structured JSON.
  2. Unhandled runtime React component exceptions could cause a blank white screen of death without diagnostic telemetry or state recovery mechanisms.
  3. Server lacked HTTP security headers (CSP, X-Content-Type-Options, X-Frame-Options, Permissions-Policy, Referrer-Policy), request size bounds, and HTTP/socket rate limit protections against DoS or room capacity exhaustion.
  4. WebRTC P2P file transfers lacked filename traversal sanitization (`../`, control chars, Windows reserved device names) and chunk count boundaries, risking client memory crashes (`RangeError: Invalid array length`).
* **Root Cause**:
  1. Express server in `server.ts` had no custom 404/500 middleware or security headers, and socket event handlers accepted unrestricted payload sizes and room creation without rate limits or room capacity caps.
  2. React root lacked an `ErrorBoundary` class wrapper.
  3. `TransferEngine.ts` and `App.tsx` did not sanitize incoming file names or enforce bounds on `meta.size` and `meta.totalChunks` when allocating chunk arrays or processing chunk indices.
* **Fix**:
  1. **Server Security & HTTP Hardening**: In [server.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/server.ts), configured full-stack security headers (`Content-Security-Policy` with Vite/WebRTC/Wasm whitelist, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`), 64kb request body parsing limits, and a sliding-window HTTP rate limiter returning `429 Too Many Requests` with `Retry-After`.
  2. **Themed Error Pages**: Added cybernetic dark neon HTML 404 & 500 error pages for web routes and clean JSON `{ error, status, path }` responses for `/api/*` endpoints.
  3. **Signaling Anti-Abuse & Validation**: Enforced room code format checks (`/^[a-zA-Z0-9_-]+$/`), client ID bounding, SDP/ICE candidate size validation (256KB/16KB), socket event rate limits (30 events/sec), and a maximum room registry cap (`MAX_ROOMS = 10000`).
  4. **React Error Boundary**: Created [src/components/ErrorBoundary.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/components/ErrorBoundary.tsx) with cybernetic crash containment UI, "Reboot System", "Purge Session & Reconnect", and collapsible diagnostic telemetry, wrapping `<App />` in [src/main.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/main.tsx).
  5. **Browser Compatibility Guard**: Added pre-flight WebRTC/Crypto/Canvas capability detection and `#unsupported-browser-screen` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) with global unhandled rejection / error protection.
  6. **P2P Data & Filename Sanitization**: Added `sanitizeFilename()` in [src/lib/TransferEngine.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/lib/TransferEngine.ts) (stripping `..`, `/`, `\`, control chars, Windows device names `CON`/`PRN`/`AUX`/`NUL`), bound file size (0–100GB) and chunk count (0–2,000,000) with `try/catch` allocation protection, and guarded chunk indices in `processChunkInternal()`.
  7. Validated with automated test suite [test_security_error_plan.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_security_error_plan.ts) and verified zero regressions across all existing engine resume suites and TypeScript typechecks.

---

## 48. Signaling Server Dot Amber/Off, Page Not Loaded & CSP Whitelist Throttling
* **Symptom**:
  1. The bottom bar "Signaling Server" dot remained amber/grey and failed to turn green.
  2. The home screen status pill stayed at "Not Connected".
  3. Clicking "Join Room" or "Create Room" displayed "Please wait, the website is still loading..." or "Connecting to signaling server... please wait." indefinitely.
  4. Browser console reported CSP violation: `Loading the script 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js' violates the following Content Security Policy directive`.
* **Root Cause**:
  1. **HTTP Rate Limiter Dev Mode & Socket Polling Throttling**: In `server.ts`, the sliding-window HTTP rate limiter (`MAX_HTTP_REQUESTS = 180` req/min) was globally intercepting all requests without bypassing Vite dev module paths (`/@vite/*`, `/@react-refresh`, `/src/*`, `/node_modules/*`) or Socket.IO transport long-polling (`/socket.io/*`). In dev mode or when self-signed certificates caused WebSocket connections to fallback to HTTP polling, Vite and Socket.IO quickly exceeded 180 requests/min, returning `429 Too Many Requests` (HTML error page) to JS modules and socket polls. This caused module parse failures that prevented React `<App />` from mounting (`window._socketJoinRoom` was never defined) and broke Socket.IO connection handshakes.
  2. **Missing CSP Script Whitelist**: The `Content-Security-Policy` header in `server.ts` omitted `https://cdnjs.cloudflare.com`, blocking `qrcode.min.js` execution.
* **Fix**:
  1. Updated `server.ts` HTTP rate limiter to exempt Vite internal development modules (`/@*`, `/src/*`, `/node_modules/*`, `/__vite*`), Socket.IO endpoints (`/socket.io/*`), PeerJS (`/peerjs/*`), static asset file extensions (`.js`, `.css`, `.wasm`, etc.), and development mode (`process.env.NODE_ENV !== "production"`). Increased baseline threshold to 600 req/min.
  2. Added `https://cdnjs.cloudflare.com` to `script-src` and `style-src` CSP directives in `server.ts`.
  3. Added graceful `EADDRINUSE` port conflict handling in `server.ts`.
  4. Validated with automated Playwright browser tests and [test_security_error_plan.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_security_error_plan.ts) & [test_otp.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_otp.cjs) (38/38 checks passed, 0 failed network requests, green signaling confirmed).

---

## 49. Mid-Transfer Disconnect Collapse, Missing ETA Progress Overlay on Resume & Room Lock Grace Preservation
* **Symptom**:
  1. When a mobile phone or peer disconnected mid-transfer, the transfer progress screen collapsed and returned to the initial drag-and-drop interface or fatal error screen.
  2. Upon reconnecting, one device resumed and showed the ETA progress screen, but the other device remained stuck on the drag-and-drop interface without showing the ETA screen, despite data actively transferring in the background.
  3. Disconnecting or backgrounding mobile devices caused the room lock to be prematurely cleared, breaking file resumption.
* **Root Cause**:
  1. **Destructive Disconnect Handlers**: `Signaling.onPeerLeft(true)` invoked `showPeerDisconnected(true)` -> `showTransferError(...)` and `resetTransferVisuals()`, which removed `.visible` from `#progress-screen` and `#receive-progress` and popped up `#transfer-error-screen`.
  2. **Unconditional Screen Override**: Server emitted `room-status: waiting` on disconnect, which unconditionally invoked `transitionToSender()`. In `transitionToSender()`, a 320ms timer added `.visible` to `#sender-screen` (drag & drop drop zone), destroying in-flight progress visuals.
  3. **Missing Sender/Receiver Overlay Hooks on Resume**: `executeTransfer()` in `src/App.tsx` started chunk sending via `TransferEngine.startTransfer()` upon receiving `START_TRANSFER` or on resume, but never re-asserted `progress-screen.visible` or `window.enterTransferVisuals('out')`.
  4. **Signaling Throttling & Disconnect Lock Race**: In `server.ts`, socket event rate limits (30/sec) dropped bursts of ICE candidates during mobile reconnections. In `server.ts` disconnect handler, `room.sourceId = null` caused the immediate `else if (room.peers.length < 2)` check to evaluate `room.sourceId !== room.peers[0]` as true and prematurely reset `room.isLocked = false`, defeating `LOCK_GRACE_MS`.
* **Fix**:
  1. **Non-Destructive Disconnect**: Updated `showPeerDisconnected(midTransfer)` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) to keep in-flight progress screens intact on midTransfer, showing a non-blocking toast (`'Peer disconnected. Waiting to resume transfer...'`) and updating stats to `'Connection paused · Reconnecting…'` while preserving progress rings.
  2. **Transfer-Aware Workspace Transitions**: Updated `transitionToSender()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) and `socket.on("room-status")` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to check `hasTransferIntent` / `isTxActive` / `isRxActive`, preserving active ETA screens and preventing unwanted `#sender-screen` overrides.
  3. **Sender & Receiver Progress Hooks**: Exposed `window.showSenderProgress()` and `window.showReceiverProgress()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), and wired them into `executeTransfer()`, `handleDropAction()`, `setupDataChannel`, and `FILE_META` auto-accept in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) so both sender and receiver ETA overlays are guaranteed to display on initial transfer and resumption.
  4. **Signaling Capacity & Lock Grace Fix**: Increased socket rate threshold to 120/sec in [server.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/server.ts) and guarded disconnect lock cleanup with `!pendingLockTimers.has(roomId)`.
  5. Created automated test suite [test_reconnect_resume_eta.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_reconnect_resume_eta.cjs) (28/28 passing checks).

---

## 50. Mobile Tab Restore Room Reset & URL Room Query Stripping
* **Symptom**:
  1. On mobile devices, after locking the screen, switching apps, or experiencing a temporary network disconnect, returning to the website reloaded the entire page from the very beginning (`#home-screen`) with blank digits instead of staying in the room and reconnecting.
  2. Resuming or auto-reconnecting failed because the mobile browser restored the page with no room parameter.
* **Root Cause**:
  1. **Premature URL Query Stripping**: In [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), `initURLRoomJoin()` parsed the room code upon scanning the QR code or opening `/?room=1234`, and immediately ran `window.history.replaceState({}, document.title, window.location.origin + window.location.pathname)`. When the mobile OS (iOS Safari / Android Chrome) backgrounded or suspended the tab and refreshed on wakeup, the browser reloaded `https://<host>/` with no room query.
  2. **Missing Session Storage Persistence**: `roomCode` was stored only in ephemeral memory (React state and Ref) without saving to `sessionStorage`. On page refresh or mobile tab restore, `App.tsx` initialized `roomCode` as `""`.
* **Fix**:
  1. **URL & Session Storage Persistence**: Updated `initURLRoomJoin()` and `joinRoom()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) as well as `_socketJoinRoom` and `_socketCreateRoom` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to store `nexus_active_room` in `sessionStorage` and maintain `?room=<code>` in `window.location.search` while the session is active.
  2. **Persistent Initializer**: Configured `src/App.tsx` to initialize `roomCode` on mount from `window.location.search` or `sessionStorage.getItem('nexus_active_room')`.
  3. **Explicit Leave Cleanup**: Updated `window.leaveRoom`, `window.leaveReceiver`, `handleBtnLeaveClick`, `handleBtnRxLeaveClick`, and `_socketLeaveRoom` to remove `nexus_active_room` from `sessionStorage` and revert the URL to `window.location.pathname` only when the user explicitly leaves the room.
  4. **Validation**: Updated [test_reconnect_resume_eta.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_reconnect_resume_eta.cjs) (33/33 tests passing).

---

## 51. Disconnect Mid-Transfer Resume, Receiver ETA Screen Loss, and Mobile Room Dropping
* **Symptom**:
  1. After a mobile device disconnected and auto-reconnected mid-transfer, the mobile device was dropped back to the room joining page (`#home-screen`).
  2. Even after reconnection, the receiver (laptop) did not display the active ETA progress screen (`#receive-progress`).
  3. The transfer on the sender (phone) remained stuck in a "paused" state with chunks not streaming.
* **Root Cause**:
  1. **Destructive State Wipe on Socket Reconnection**: In [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), `socket.on("connect")` passed `isTransferringRef.current` (which was already set to `false` when data channels closed) to `resetWebRTCConnection(preserveTransferState)`. Because `preserveTransferState` was `false`, `resetWebRTCConnection` wiped `transferRequestedRef`, `incomingFileRef`, `preservedResumeManifestRef`, and `transferIdRef`.
  2. **Failed Channel Reopen Triggers**: In `setupDataChannel`, channel open hooks checked `transferEngineRef.current` (which was set to `null` on disconnect) and `isTransferringRef.current` (which was `false`), preventing `START_TRANSFER` and `RESUME_REQUEST` from firing.
  3. **Receiver FILE_META Auto-Accept Bypass**: When `FILE_META` arrived on the receiver after reconnection, `transferRequestedRef.current` was `false`, causing the receiver to treat it as a fresh manual drop request without showing the ETA progress screen or sending `START_TRANSFER`.
  4. **Sender False Intent Reset**: In `socket.on("room-status")`, `hasTransferIntent` did not account for sender file selection or `transferIdRef`, causing `transitionToSender` to dismiss the sender progress screen.
  5. **Uninitialized `roomCodeRef` on Initial Mount**: In `src/App.tsx`, `roomCodeRef` started empty (`""`), causing quick socket reconnects to skip auto-rejoining the room.
* **Fix**:
  1. **Comprehensive `hasTransferIntent` Preservation**: Updated `socket.on("connect")`, `socket.on("room-status")`, and `socket.on("peer-disconnected")` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to evaluate `isTransferringRef.current || transferRequestedRef.current || !!incomingFileRef.current || (isSourceRef.current && selectedFilesRef.current.length > 0) || !!transferIdRef.current || preservedResumeManifestRef.current !== null` before resetting WebRTC or triggering UI screen transitions.
  2. **Reliable Channel Open Resume & Re-Probe**: Updated `setupDataChannel` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) so the receiver sends `START_TRANSFER` with its manifest and re-asserts `showReceiverProgress()`, or requests `REQUEST_FILE_META` if the engine needs reconstruction. The sender re-asserts `showSenderProgress()` and sends `RESUME_REQUEST`.
  3. **Guaranteed Receiver Auto-Accept & ETA Screen**: In `FILE_META` handler in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), check `isResuming = transferRequestedRef.current || preservedResumeManifestRef.current !== null`, immediately triggering `(window as any).showReceiverProgress(...)` and transmitting `START_TRANSFER`.
  4. **Direct `roomCodeRef` Initialization**: Initialized `roomCodeRef` with `roomCode` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx).
  5. **Dead-State & Button Accessibility Protections**: In [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), updated `showSenderProgress` and `showReceiverProgress` to reset `#btn-cancel` and `#btn-rx-cancel` to `style.display = ''` and hide cancel-confirm dialogs, and guarded `transitionToReceiver` timer against active receive transfers.
  6. **Automated Verification**: Added comprehensive checks to [test_reconnect_resume_eta.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_reconnect_resume_eta.cjs) (33/33 tests passing).

---

## 52. Custom Room Code Entry & Disconnection Page Persistence
* **Symptom**:
  1. Visiting the root website URL (`/`) auto-joined a previously visited room (e.g. `1111`) instead of allowing users to type and join/create their own unique room code.
  2. Typing a custom 4-digit room code and clicking "Create Room" overwrote the user's entered digits with a random number.
  3. On peer disconnection or socket reconnection, the receiver device's screen was forcibly flipped to the sender drag-and-drop workspace, making the website appear to refresh/reset on each disconnect.
* **Root Cause**:
  1. `initURLRoomJoin()` in `index.html` and `useState` in `App.tsx` restored `sessionStorage.getItem('nexus_active_room')` unconditionally on page load, auto-filling stale digits (such as `1111`) and immediately auto-joining.
  2. `socket.on("connect")` and `handleVisibilityChange` in `src/App.tsx` evaluated `if (roomCodeRef.current.length === 4)` without checking `joinedRef.current`, causing initial socket connects on page load to immediately transmit `join-room` before the user clicked any button.
  3. `btn-create` click listener in `index.html` unconditionally generated a random 4-digit number without checking if the user already typed a custom 4-digit code in the OTP boxes.
  4. `socket.on("room-status")` in `src/App.tsx` hardcoded calls to `transitionToSender()`, tearing down active receiver workspaces on reconnects/status changes.
* **Fix**:
  1. **Clean Root URL Entry & auto=1 Guard**: Updated `initURLRoomJoin()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) and `roomCode` initialization in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) so visiting `/` with no `?room=` clears stale session storage and starts with clean empty OTP boxes. Auto-joining from URL is guarded by `auto=1` (embedded in QR codes for seamless mobile camera scanning).
  2. **Active Room Join Guard (`joinedRef.current`)**: Updated `socket.on("connect")` and `visibilitychange` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to strictly check `joinedRef.current && roomCodeRef.current.length === 4`, preventing initial socket handshakes from ever sending unwanted `join-room` events.
  3. **Custom Room Code Creation**: Updated `btn-create` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) to check `getCode()`: if 4 digits are typed, it creates the room using the user's custom code; if empty, it generates a random code.
4. **Role & Screen Persistence on Disconnect**: Updated `socket.on("room-status")` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to detect `isCurrentlyReceiver` and preserve the active screen (`transitionToReceiver` vs `transitionToSender`), ensuring users stay on their exact page until they explicitly click "Leave Room".
   5. **Automated Verification**: Created and verified test suite [test_custom_room_and_disconnect_persistence.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_custom_room_and_disconnect_persistence.cjs) (9/9 checks passed) and [test_reconnect_resume_eta.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_reconnect_resume_eta.cjs) (33/33 checks passed).

---

## 53. Residual Room Pre-Load Pre-Fill, Disconnect Screen Flip & Reconnect Resume Gaps
* **Symptom**:
   1. Despite entry #52's fixes being present in the working tree, the regressions still reproduced: a plain visit (or a leftover `?room=1111` URL) pre-filled the OTP boxes and re-joined a stale room; a disconnect or reconnect flipped a receiver back to the sender drag-and-drop workspace ("apparent reload"); and pure data-channel death with a live signaling socket waited up to 8-30s before WebRTC was rebuilt.
* **Root Cause**:
   1. **Bare-`?room=` Pre-Fill Branch**: `initURLRoomJoin()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2740) still had an `else if (urlRoom && /^\d{4}$/.test(urlRoom))` branch that filled the OTP boxes and rendered a QR for any bare `?room=XXXX` URL (no `auto=1`), re-triggering the stale-room restore the #52 fix was meant to remove.
   2. **`global-unlock` Unconditional Transition**: `socket.on("global-unlock")` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L578) still called `transitionToSender(roomCodeRef.current)` unconditionally after lock-grace expiry, flipping a non-transferring receiver to the sender workspace even when it had never sent anything.
   3. **`joined && roomCode` Effect Unconditional Transition**: The effect at [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L2012) called `transitionToSender?.(safeCode)` on every join, so a first join or reconnect could yank a waiting receiver to the sender workspace.
   4. **Delayed DOM-Class Screen Identity**: Screen placement decisions read `document.getElementById('receiver-screen')?.classList.contains('visible')`, which only becomes true 340ms after a transition starts and stays sticky after a sender flip — so a reconnect burst decided the screen by whichever transition timer ran last.
   5. **Data-Channel Death With Live Socket**: `dc.onclose` set `connectedRef=false` but only the 8-30s health-check interval could re-emit `join-room` for pure data-channel death (network switch) while the signaling socket stayed alive.
* **Fix**:
   1. **Strip Bare `?room=`**: Removed the pre-fill branch in `initURLRoomJoin()` ([index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L2740)); a bare 4-digit `?room=` without `auto=1` now rewrites the URL via `history.replaceState` to the bare pathname and leaves the boxes empty. The `?room=X&auto=1` QR-join branch is unchanged.
   2. **Synchronous Screen Identity (`__nexusCurrentScreen`)**: `transitionToSender`/`transitionToReceiver`/`leaveRoom`/`leaveReceiver` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) now set `window.__nexusCurrentScreen` synchronously; `src/App.tsx` tracks it via `lastScreenRef` and reads that instead of the delayed DOM class.
   3. **`global-unlock` Stops Driving Placement**: Removed the `transitionToSender` call from `socket.on("global-unlock")` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L578); it now only resets state/UI. Screen placement is owned by `room-status` and the screen ref.
   4. **Gated `joined && roomCode` Effect**: The effect at [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L2012) keeps `Signaling.setRoomCode` but only calls `transitionToSender` when the current screen is not `receiver`, so a first join/reconnect cannot yank a waiting receiver.
   5. **Idempotent Transitions (KTD4)**: `transitionToSender`/`transitionToReceiver` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) return early when the target screen already has `.visible` and no transfer state changed, preventing reconnect bursts from churning the shared `+320/340ms` last-wins timer.
   6. **Success-Screen Protection (KTD6)**: `room-status` waiting/ready transitions in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L443) are skipped while `success-screen`/`receive-success` is visible, so a peer leave after a completed transfer never flips away from the success screen.
   7. **Bounded Rejoin on Data-Channel Death (KTD5)**: `dc.onclose` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L1417) re-emits `join-room` (rate-limited via `lastRejoinRef`) when the signaling socket is still connected and the room is joined, closing the 8-30s resume stall for pure data-channel death.
   8. **Receiver Latch Released on Idle Peer Leave (KTD6)**: `showPeerDisconnected(midTransfer=false)` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html#L4013) now calls `stopReceiverAnimation()` after `resetTransferVisuals()`. `resetTransferVisuals()` hides the receive-progress overlay but left `rxTransferActive` true, so the later `transitionToReceiver` (from the `room-status:waiting` handler) refused to reveal the receiver-screen — a sender leave while the receiver was idle left a blank state instead of the receiver workspace (R8/SC4).
   9. **Automated Verification**: Added behavioral Playwright suite [test_room_load_disconnect_resume.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_room_load_disconnect_resume.cjs) proving R1/R2/R3/R10/R11 (clean entry, auto-join, create-room) and R5/R7/R8 (mid-transfer drop resume, no reload, no receiver flip). Static suites updated: [test_custom_room_and_disconnect_persistence.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_custom_room_and_disconnect_persistence.cjs) (9/9) and [test_reconnect_resume_eta.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_reconnect_resume_eta.cjs) (33/33) green; `npm run lint` passes.

---

## 54. Mobile File Selection Disconnect / Tab Restore Room Ejection & Disconnect Resume UX
* **Symptom**:
   1. On mobile devices, selecting a file opens the native OS file picker which backgrounds the browser tab. When returning, or when the mobile device disconnects from the signaling server, the mobile browser discards/reloads the page or reconnects, causing the user to get kicked out to the empty home screen and having to find/re-enter the room and select the file again.
   2. During active mid-transfer disconnects, the silent reconnection was not resuming properly or the page appeared to reset instead of transitioning from "Connection paused · Reconnecting…" back to active receiving with speed and ETA.
   3. "Create New Room" button auto-fills the 4 digits and generates QR, but users must be able to view the digits and manually click "Join Room" to enter.
* **Root Cause**:
   1. `initURLRoomJoin()` in `index.html` treated any `?room=XXXX` URL without `auto=1` or `pendingRestore` as a "stale" room, executing `else if (urlRoom && /^\d{4}$/.test(urlRoom))` which removed `nexus_active_room` from `sessionStorage` and stripped `?room=` from the URL on any tab restore/reload while actively inside a room.
   2. `roomCode` state in `src/App.tsx` only initialized if `autoJoin === '1'`, returning `""` on standard tab reloads even when `sessionStorage` or the active URL preserved the room session.
   3. `handleVisibilityChange` in `src/App.tsx` guarded resume hooks with `if (isTransferringRef.current)`. However, `resetWebRTCConnection(true)` or `dc.onclose` resets `isTransferringRef` to `false` while preserving transfer intent (`transferRequestedRef`, `preservedResumeManifestRef`, `transferIdRef`), preventing visibility foreground return from re-asserting progress overlays and triggering immediate resume handshakes.
* **Fix**:
   1. **Active Room Session & Tab Restore Retention**: Updated `initURLRoomJoin()` in [index.html](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) and `roomCode` initial state in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to check `storedRoom === urlRoom` in addition to `autoJoin === '1'` and `pendingRestore`. A mobile tab restore/reload while in an active room session preserves the room and auto-rejoins seamlessly without ejecting the user.
   2. **Transfer Intent Foreground Resume**: Updated `handleVisibilityChange` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) to check `hasActiveTransferIntent` (`isTransferringRef.current || (isGlobalLockedRef.current && (transferRequestedRef.current || preservedResumeManifestRef.current !== null || (isSourceRef.current && !!transferIdRef.current)))`), re-asserting progress overlays and firing resume handshakes (`START_TRANSFER` or `RESUME_REQUEST`) upon returning to foreground.
   3. **Create Room Separation**: Verified that `btn-create` strictly generates/populates the 4 digits and updates the QR code without auto-joining. The creator views the code on screen and clicks "Join Room" to initiate room entry.
   4. **Automated Verification**: Verified with full test suites:
      - [test_room_load_disconnect_resume.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_room_load_disconnect_resume.cjs): 20/20 checks passed (100%).
      - [test_reconnect_resume_eta.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_reconnect_resume_eta.cjs): 33/33 checks passed (100%).
      - [test_custom_room_and_disconnect_persistence.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_custom_room_and_disconnect_persistence.cjs): 9/9 checks passed (100%).
      - [test_otp.cjs](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_otp.cjs): 38/38 checks passed (100%).
       - `npm run build`: built cleanly in production with zero errors.

---

## 56. Cancel Transfer — Drop Zone Hidden After Cancel on Both Devices
* **Symptom**: After pressing "Yes, Cancel" on the cancel-transfer confirmation, the drop-zone/drag-and-drop box did not reappear on either the sender or receiver device. The UI was stuck on the (invisible) progress overlay state.
* **Root Cause**: `cancelTransfer()` in `src/App.tsx` calls `setIsTransferring(false)` (async React state update) and then immediately calls `(window as any).onTransferCancelled?.()` synchronously (before any re-render). `onTransferCancelled()` calls `transitionToSender()`, which reads `window.getTransferPhase()` — but that value is only updated via a `useEffect` that runs after the re-render. So `getTransferPhase()` still returns `'active'` at call time, making `isTxActiveNow = true`. This caused `transitionToSender()` to:
  1. Skip clearing `#progress-screen.visible` (blocked by `!isTxActive` guard at line 3064 of `index.html`).
  2. Skip the 320ms timer that re-adds `sender-screen.visible` (blocked by `!isTxActive && !isRxActive` guard at line 3080).
  The same race existed on the peer device that received the `CANCEL_TRANSFER` data-channel message.
* **Fix**: Added `(window as any).setTransferPhase?.('idle')` synchronously immediately before `onTransferCancelled()` in both:
  - The initiator path in `cancelTransfer()` (before `onTransferCancelled`)
  - The peer path in the `CANCEL_TRANSFER` data-channel handler
  Also added `midTransferDisconnectRef.current = false` at both call sites to avoid leaving stale reconnect-guard state after an explicit cancel.
* **Convention**: Any future `hasTransferIntent` expression in a socket/reconnect handler MUST include `midTransferDisconnectRef.current` to maintain silent reconnect behavior.
* **Files modified**: [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx)

---

## 58. Cancel Transfer — Headless/Blank UI State and Reconnection State Resilience
* **Symptom**:
  1. Clicking "Cancel Transfer" on either device caused both devices to enter a headless/blank state where the drag-and-drop box and all action buttons disappeared entirely.
  2. Temporary server disconnection was causing abrupt UI state disruptions instead of seamless silent reconnection.
* **Root Cause**:
  1. In `index.html`, `onTransferCancelled()` attempted to retrieve the room code via `badge.textContent.replace('Room ', '').trim()`. If the badge contained `'Receive'` or `'----'`, or if the text evaluated to `""`, the transition guard `if (roomCodeText && typeof window.transitionToSender === 'function')` skipped calling `transitionToSender`, leaving `#sender-screen` with `opacity: 0; pointer-events: none;` and progress overlays removed. Furthermore, `transitionToSender`'s 320ms transition timer could be cleared by the incoming `global-unlock` event from the server, stranding `#sender-screen` without `.visible`.
  2. `isSource` and `isSourceRef` in `src/App.tsx` were not explicitly reset in `cancelTransfer` and the `CANCEL_TRANSFER` peer handler, leaving stale role states.
* **Fix**:
  1. **Guaranteed UI State Restoration on Cancel**: Updated `onTransferCancelled()` in [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) to:
     - Robustly sanitize badge text and fall back to `sessionStorage.getItem('nexus_active_room')` to guarantee a valid `safeRoomCode`.
     - Always call `transitionToSender(safeRoomCode)` without blocking on `roomCodeText` truthiness.
     - Immediately and synchronously enforce `#sender-screen.classList.add('visible')` and `#drop-zone.style.display = ''; opacity = '1'; pointerEvents = 'all'` so the drag-and-drop box and action controls are immediately usable on both devices without waiting on or depending on timer lifecycles.
     - Synchronously remove `document.body.classList.remove('transferring')` and hide all progress overlays.
  2. **Role & Intent Reset**: Added `setIsSource(false)` and `isSourceRef.current = false` in both `cancelTransfer()` and the peer `CANCEL_TRANSFER` message handler in [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx).
* **Files modified**: [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`test_exit_paths.cjs`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_exit_paths.cjs), [`code_debugged.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/code_debugged.md)

---

## 59. Render Cloud Deployment, Cold-Start Countdown Wakeup Toast & Server Keep-Alive Strategy
* **Symptom**: On free cloud tiers (e.g. Render.com), the server sleeps after 15 minutes of inactivity. When opening the web app, initial signaling connection took 30–50 seconds, displaying a disconnected state or jarring error spam ("Cannot reach signaling server") with no explanation to the user. Hardcoded port 3000 caused boot failures on cloud environments requiring dynamic `PORT` assignment.
* **Root Cause**:
  1. `PORT` was hardcoded to `3000` in `server.ts` without reading `process.env.PORT`.
  2. Express and Socket.IO lacked CORS configuration and health check endpoints for split deployments (e.g. Cloudflare Pages frontend + Render backend).
  3. No pre-warm HTTP ping or client-side cold-start detection mechanism existed.
  4. Repetitive `connect_error` events on Socket.IO spammed error toasts during initial server spin-up.
* **Fix**:
  1. **Dynamic Port & CORS in `server.ts`**: Bound `Number(process.env.PORT) || 3000`, added Express CORS middleware supporting `ALLOWED_ORIGINS` / `CORS_ORIGIN`, and added lightweight `/healthz` endpoint (`200 OK`) and `/api/server-info` status reporting.
  2. **Internal Keep-Alive Heartbeat in `server.ts`**: Added automated 12-minute heartbeat self-ping when `KEEP_ALIVE=true` or `RENDER_EXTERNAL_URL` is set, compliant with Render's 750 free monthly hour allowance.
  3. **Immediate Client-Side HTTP Pre-Warm in `src/App.tsx`**: Fired a non-blocking `fetch(SERVER_URL + "/healthz")` immediately on initial React mount to trigger container boot before WebSockets negotiate.
  4. **Smart Cold-Start Wakeup Toast in `index.html` & `src/App.tsx`**:
     - 3.0s grace window: Fast local or warm connections (<3s) show zero toasts, keeping the UI completely clean.
     - Slow connections (>3s): Displays informative live countdown toast (`⚡ Waking up signaling network (free tier spin-up)... ~40s remaining`) ticking down each second.
     - On connect: Smoothly transitions into green confirmation toast (`🟢 Connected to Signaling Network! Ready to share.`) with 3.5s auto-dismiss.
     - On timeout: Displays `Almost ready... Finalizing server handshake` with an interactive "Retry Now" action button.
  5. **Error Suppression During Wakeup**: Gated `showSignalingError` so cold-start retries do not spam error toasts over the countdown UI.
  6. **Production Scripts & Documentation**: Added `"start": "tsx server.ts"` in `package.json` and created comprehensive runbook [`docs/deployment_guide.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/docs/deployment_guide.md) detailing Render All-in-One, Cloudflare Pages + Render split deployment, and free UptimeRobot/cron-job.org keep-alive configurations.
* **Files modified**: [`server.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/server.ts), [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`src/global.d.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/global.d.ts), [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`package.json`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/package.json), [`docs/deployment_guide.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/docs/deployment_guide.md), [`docs/plans/2026-08-15-002-render-deployment-wakeup-toast-and-keepalive-plan.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/docs/plans/2026-08-15-002-render-deployment-wakeup-toast-and-keepalive-plan.md)


---

## 60. Seamless Server Reconnection — Prevention of Browser Reloads & Receiver Workspace Reset
* **Symptom**: During server reconnection or network drops, the web page reloaded repeatedly or flipped from the active receiving progress screen to the sender drag-and-drop box, appearing to reset the page.
* **Root Cause**:
  1. **Transfer Phase Falling to Idle**: In `src/App.tsx`, `transferPhase` React state calculation evaluated `!isTransferring` as `'idle'` on disconnect, ignoring `midTransferDisconnectRef.current` and `preservedResumeManifestRef.current`. This caused `window.getTransferPhase()` in `index.html` to return `'idle'` while channels were reconnecting.
  2. **Screen Identity Desynchronization**: `window.__nexusCurrentScreen` was not updated to `'receiver'` during drop action, incoming file meta, or receive progress display. When `socket.on("room-status")` received `waiting` or `ready`, `isCurrentlyReceiver` evaluated to `false`, causing the receiver to call `transitionToSender()`.
  3. **Progress Screen Destruction in `transitionToSender`**: In `index.html`, `transitionToSender` evaluated `isTxActiveNow` and `isRxActiveNow` as `false` during reconnect because `getTransferPhase()` was `'idle'`. It removed `.visible` from `#receive-progress` and scheduled `#sender-screen.visible`, flipping the receiver device into the sender workspace.
  4. **Vite Dev Server HMR Reconnect Loop**: In `server.ts`, Vite dev server `hmr: { server: httpServer }` was not conditional on `DISABLE_HMR`. When the server dropped, Vite's client WebSocket disconnected, polled for restart, and triggered `location.reload()` upon reconnection.
  5. **Unconditional Server Disconnect Handling**: In `src/App.tsx`, `socket.on("disconnect")` did not manually call `socket.connect()` when `reason === "io server disconnect"`.
* **Fix**:
  1. **Preserved Active Phase on Disconnect**: Updated `transferPhase` in [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) so `isMidTransfer = midTransferDisconnectRef.current || preservedResumeManifestRef.current !== null` maintains `'active'`, ensuring `window.getTransferPhase()` never reports `'idle'` during a reconnect pause.
  2. **Strict Screen Identity Synchronization**: Set `window.__nexusCurrentScreen = 'receiver'` and `lastScreenRef.current = 'receiver'` in `handleDropAction()`, `triggerIncomingSphere()`, `showReceiverProgress()`, `setupDataChannel`, and `FILE_META` auto-resuming handler in [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) and [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html).
  3. **Receiver Workspace Protection**: In `transitionToSender()` in [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), added an explicit guard: if `window.__nexusCurrentScreen === 'receiver'`, immediately redirect to `transitionToReceiver(code)` and return, never flipping screen identity or tearing down the receive progress UI.
  4. **HMR Configuration**: Updated `server.ts` to respect `process.env.DISABLE_HMR === 'true'` (disabling HMR auto-reload client when set).
  5. **Socket Disconnect Reconnection**: Added auto-reconnect on `"io server disconnect"` in `src/App.tsx`.
* **Automated Verification**:
  - `test_room_load_disconnect_resume.cjs`: 20/20 checks passed (100%).
  - `test_reconnect_resume_eta.cjs`: 33/33 checks passed (100%).
  - `test_custom_room_and_disconnect_persistence.cjs`: 9/9 checks passed (100%).
  - `test_exit_paths.cjs`: 21/21 checks passed (100%).
* **Files modified**: [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`server.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/server.ts), [`test_exit_paths.cjs`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_exit_paths.cjs), [`code_debugged.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/code_debugged.md)

---

## 61. Receiving Device File Receiving Animation Overlap with Drag & Drop Box
* **Symptom**: On the receiving device, when a file transfer begins or when receiving file chunks, the circular file receiving animation (`#receive-progress` and `#transfer-rings-canvas`) visually overlapped with the drag-and-drop box (`#drop-zone` inside `#sender-screen`). The drag-and-drop box rendered underneath/through the receiving progress screen.
* **Root Cause**:
  1. **Unhandled Screen Transition Timer Race (`window.__nexusScreenTransitionTimer`)**: When a user joined a room or connected to a peer, `transitionToSender()` scheduled a 320ms timer (`setTimeout(..., 320)`) to add `.visible` to `#sender-screen`. When incoming file metadata (`FILE_META`) or `global-lock` arrived on the receiver, `triggerIncomingSphere()`, `showReceiverProgress()`, and `startReceive()` executed without cancelling `window.__nexusScreenTransitionTimer`. At +320ms, the timer fired and executed `document.getElementById('sender-screen').classList.add('visible')`, resurrecting `#sender-screen` and `#drop-zone` directly beneath the transparent `#receive-progress` overlay.
  2. **Timer Callback Lacked Active Receive State Verification**: The 320ms `transitionToSender()` timer callback unconditionally added `.visible` to `#sender-screen` without verifying whether a transfer was active or whether `#receive-progress.visible` / `#receiver-screen.visible` / `rxTransferActive` was true.
  3. **CSS Opacity Transition Bleed & Display Latch**: `#sender-screen` only had `transition: opacity 0.35s ease;` without an immediate `display: none !important;` rule when not `.visible`. During the 350ms fade-out transition, `#sender-screen` and `#drop-zone` remained rendered on screen while `#receive-progress` was immediately visible.
  4. **CSS Layout Isolation Missing for Receiver & Transferring States**: CSS rules only enforced `body.transferring #drop-zone { display: none !important; }` but lacked rules hiding `#sender-screen`, `#drop-zone`, and `#queue-wrap` when `body:has(#receive-progress.visible)`, `body:has(#receiver-screen.visible)`, or `body:has(#receive-success.visible)` was active.
  5. **Missing Synchronous DOM Banishment in Receiver Entry Points**: `triggerIncomingSphere()`, `showReceiverProgress()`, and `transitionToReceiver()` removed `.visible` classes but did not synchronously clear pending transition timers or apply `style.display = 'none'` on `#sender-screen`, `#drop-zone`, and `#queue-wrap`.
* **Fix**:
  1. **Strict CSS Layout Isolation in `index.html`**:
     - Added `#sender-screen:not(.visible) { display: none !important; opacity: 0 !important; pointer-events: none !important; }` to eliminate opacity transition bleed.
     - Added compound selector rules ensuring `#sender-screen`, `#drop-zone`, and `#queue-wrap` are strictly `display: none !important; opacity: 0 !important; pointer-events: none !important;` whenever `body.transferring`, `body:has(#receive-progress.visible)`, `body:has(#receiver-screen.visible)`, or `body:has(#receive-success.visible)` is active.
     - Added symmetric rules hiding receiver UI elements (`#receiver-screen`, `#receive-progress`, `#gravity-well-ui`) when sender `#progress-screen.visible` is active.
  2. **Timer Cancellation & Runtime Receiver Guards in `transitionToSender`**:
     - In `transitionToSender()`, added checks for `isRxActiveNow` (active receive or receive progress visible) to abort immediately and delegate to `transitionToReceiver()`.
     - In `transitionToSender()`'s 320ms `setTimeout` callback, added runtime verification re-checking `getRxTransferActive()`, `receive-progress.visible`, `receive-success.visible`, and `body.transferring` before adding `.visible` to `#sender-screen`.
  3. **Synchronous Timer Clearing & DOM Banishment in Receiver Entry Hooks**:
     - Updated `triggerIncomingSphere()`, `showReceiverProgress()`, `showSenderProgress()`, and `transitionToReceiver()` to immediately clear `window.__nexusScreenTransitionTimer`.
     - Updated `triggerIncomingSphere()` and `showReceiverProgress()` to synchronously set `style.display = 'none'` on `#sender-screen`, `#drop-zone`, and `#queue-wrap`.
     - Synchronously updated `window.__nexusCurrentScreen = 'receiver'` on `socket.on("global-lock")` in `src/App.tsx`.
  4. **Clean Idle State Recovery**:
     - Ensured `onTransferCancelled()`, `sendAnotherFile()`, and `dismissSuccess()` cleanly clear inline styles and restore `#sender-screen` and `#drop-zone` visibility only when transitioning back to idle sender mode.
* **Automated Verification**:
  - `test_receiver_animation_overlap.cjs`: 9/9 checks passed (100%) across all 4 scenarios (transitionToSender race, mid-receive transitionToSender protection, showReceiverProgress direct invocation, and clean cancel/idle recovery).
  - `test_exit_paths.cjs`: 21/21 checks passed (100%).
  - `test_custom_room_and_disconnect_persistence.cjs`: 9/9 checks passed (100%).
  - `test_room_load_disconnect_resume.cjs`: 25/25 checks passed (100%).
  - `npm run lint`: 0 errors.
* **Files modified**: [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`test_receiver_animation_overlap.cjs`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_receiver_animation_overlap.cjs), [`code_debugged.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/code_debugged.md)

---

## 62. Seamless Silent Reconnection, Zero-Reload State Preservation & ClientId Retention
* **Symptom**:
  1. When network disconnected temporarily or signaling server restarted, devices reloaded the page, lost active room parameters, or flipped the receiver workspace into the sender drag-and-drop workspace.
  2. Rejoining sockets were occasionally rejected as a 3rd peer or had roles desynchronized because the server purged client mapping on disconnect.
* **Root Cause**:
  1. `server.ts` executed `room.peerClientIds.delete(socket.id)` immediately on socket disconnect, losing the client identity before the rejoining socket could connect with the same `clientId`.
  2. `genuinelyDeadPeers` in `server.ts` ran before `clientId` lookup, purging the socket prior to socket replacement.
  3. `transitionToSender()` in `index.html` lacked an immediate guard against `window.__nexusCurrentScreen === 'receiver'`, occasionally tearing down the receiver screen on `room-status: ready`/`waiting` events.
* **Fix**:
  1. **ClientId Retention across Grace Window**: Updated `server.ts` to retain `room.peerClientIds` across disconnects, and prioritized `clientId` matching & socket replacement in `join-room` before purging genuinely dead peers.
  2. **Synchronous Receiver Screen Protection**: In `index.html` (`transitionToSender()`), ensured `window.__nexusCurrentScreen === 'receiver'` immediately delegates to `transitionToReceiver()`, preventing workspace flips on socket events.
  3. **Guarded Cancellation Recovery**: Updated `onTransferCancelled()` in `index.html` to set `window.__nexusCurrentScreen = 'sender'` before calling `transitionToSender(safeRoomCode)` when room is unlocked.
  4. **Automated Verification**:
     - `test_room_load_disconnect_resume.cjs`: 25/25 checks passed (100%).
     - `test_reconnect_resume_eta.cjs`: 33/33 checks passed (100%).
     - `test_custom_room_and_disconnect_persistence.cjs`: 9/9 checks passed (100%).
     - `test_receiver_animation_overlap.cjs`: 9/9 checks passed (100%).
     - `test_exit_paths.cjs`: 21/21 checks passed (100%).
     - `test_otp.cjs`: 38/38 checks passed (100%).
     - `npm run lint`: 0 errors.
     - `npm run build`: built cleanly with 0 errors.
* **Files modified**: [`server.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/server.ts), [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`code_debugged.md`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/code_debugged.md)

---

## 63. Transfer Completion Lifecycle, Sender Blank Screen & Receiver Loop Trapping
* **Symptom**:
  1. On the sender device, after a transfer completed and the 6-second success modal was dismissed (or "Send Another File" clicked), the screen became completely blank without restoring the interactive drag-and-drop workspace (`#drop-zone`).
  2. On the receiver device, after file assembly completed and the success modal dismissed on an unlocked room, the receiver was re-locked into the receiving loop screen (`#receiver-screen` with `#gravity-well-ui` radar animation) instead of cleanly returning to the sender drop-zone workspace.
* **Root Cause**:
  1. `resetSenderUI()` and `sendAnotherFile()` in `index.html` removed `#success-screen.visible` but never explicitly cleared inline `style.display = 'none'` or re-added `.visible` to `#sender-screen`, causing CSS rule `#sender-screen:not(.visible) { display: none !important; }` to keep `#sender-screen` hidden.
  2. `dismissSuccess()` in `index.html` called `transitionToSender(roomCodeText)`, but `transitionToSender()` contained an unconditional check `if (window.__nexusCurrentScreen === 'receiver')` which delegated back to `transitionToReceiver()`, trapping the receiver in the receiver screen loop.
* **Fix**:
  1. **Sender UI Restoration**: Updated `sendAnotherFile()` and `resetSenderUI()` in [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) to set `window.__nexusCurrentScreen = 'sender'`, enforce `#sender-screen.classList.add('visible')` with `style.display = ''`, and restore `#drop-zone.style.display = ''`, `opacity = '1'`, and `pointerEvents = 'all'`.
  2. **Receiver Workspace Release**: In [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html) (`dismissSuccess()`), when the room is unlocked (`!isLocked`), reset `window.__nexusCurrentScreen = 'sender'`, hide `#gravity-well-ui`, and transition cleanly to `transitionToSender(roomCodeText)`.
  3. **Transition Receiver Guard Refinement**: Refined `isRxActiveNow` in `transitionToSender()` so it only intercepts when an active receive transfer is in flight or room is locked.
* **Files modified**: [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`test_completion_screen_restoration.cjs`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_completion_screen_restoration.cjs)

---

## 64. Small-File 1333% Progress Overshoot & Decoupled Vite HMR Auto-Reload
* **Symptom**:
  1. Transferring small files (e.g. 9.8 KB) initially displayed `1333%` progress on both sender and receiver progress rings/percentages.
  2. During network interface switches or dev reconnection, Vite's client WebSocket disconnected and triggered `window.location.reload()`, interrupting the session.
* **Root Cause**:
  1. In `src/lib/TransferEngine.ts`, `this.bytesTransferred = Math.max(this.bytesTransferred, this.ackedChunks.size * CHUNK_SIZE)` assumed all chunks were full 128 KB chunks. On a 9.8 KB file with 1 chunk, `1 * 131072 = 131072` bytes, leading to `(131072 / 9830) * 100 = 1333.38%`.
  2. In `server.ts`, Vite dev server attached `{ server: httpServer }` to HMR unconditionally unless `DISABLE_HMR=true` was provided.
* **Fix**:
  1. **Exact Chunk Byte Calculation & Clamping**: Updated `resumeTransfer`, `handleAck`, and `handleIncomingChunk` in [`src/lib/TransferEngine.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/lib/TransferEngine.ts) to calculate partial byte sizes for the last chunk and clamp `bytesTransferred` to `totalSize`. Clamped telemetry `progress` to `[0, 100]`.
  2. **UI Clamping Safeguard**: Clamped `safeRatio = Math.min(1, Math.max(0, transferProgress / 100))` in [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx) and clamped progress in `updateSenderProgress` / `updateReceiverProgress` in [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html).
  3. **Vite HMR Decoupled**: Updated `server.ts` so `hmr: process.env.ENABLE_HMR === 'true' ? { server: httpServer } : false`, preventing dev server HMR client disconnects from reloading the browser.
* **Files modified**: [`src/lib/TransferEngine.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/lib/TransferEngine.ts), [`src/App.tsx`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [`index.html`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/index.html), [`server.ts`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/server.ts), [`test_small_file_progress.cjs`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_small_file_progress.cjs), [`test_silent_reconnect_no_reload.cjs`](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/test_silent_reconnect_no_reload.cjs)



