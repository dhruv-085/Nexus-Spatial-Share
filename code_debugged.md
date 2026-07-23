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
  4. Enhanced `handleVisibilityChange` in [src/App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx#L201-L215) to auto-emit `START_TRANSFER` with `resumeManifest` and display a toast notification when returning to foreground during an active transfer.



