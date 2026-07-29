# Technical Implementation Plan: WebRTC Transfer & UI State Fixes

This plan outlines the design changes, implementation details, and test cases required to resolve the 8 bugs identified in the WebRTC transfer flow and DOM integration layer.

---

## 1. Problem Frame & Scope Boundary
The current implementation of **Nexus Spatial Share** uses a headless React state orchestrator (`src/App.tsx`) bridged via a window-property API to a custom canvas/HTML visual layer (`index.html`). Under weak network conditions, dual role-reversals, multi-file transfers, or gesture-initiated actions, visual state synchronization breaks down. 

The scope is bounded to:
- Fixing UI freezes on weak networks before signaling is online.
- Ensuring hand gestures drive the same state-transition pipelines as button clicks.
- Streamlining the file progress UI and success state sequencing.
- Fixing state residue after WebRTC resets to support seamless bidirectional transfer role-swaps.
- Supporting multi-file batch transfers without UI overlaps.
- Restoring state to the symmetrical idle workspace (`#sender-screen`) after completion/cancel.
- Keeping the files drawer toggle visible when files are in the received buffer.

---

## 2. Repo-Relative Target Files
The modifications will be restricted to the following files:
- `src/App.tsx` — Handles signaling events, WebRTC lifecycle, MediaPipe gestures, and bridges state down.
- `index.html` — Renders the visual canvas, button click event listeners, screen transitions, and animations.

---

## 3. Detailed Decisions & Rationale

### 3.1. Issue 1: UI Freeze on Slow Network Room Join/Create
*   **Root Cause**: If the page loads and the user clicks Join/Create before Socket.io connects, `joinRoom` falls back to `showRolePicker()`. However, `#role-picker` is hardcoded to `display: none !important`, leaving a blank, unresponsive screen.
*   **Decision**: 
    - Buffer the join/create request. Socket.io naturally buffers emits before connection.
    - If `window._socketJoinRoom` / `window._socketCreateRoom` is defined, call them immediately.
    - If `_socketIsConnected()` is false, display a non-blocking error feedback (`'Connecting to signaling server... please wait.'`) in the `#join-error` container instead of hiding the home card.
    - If the React context hasn't loaded yet (meaning `_socketJoinRoom` is not even defined), show `'Initializing... please wait.'`.

### 3.2. Issue 2: Grab Gesture Bypasses Progress UI & Metrics
*   **Root Cause**: When MediaPipe detects a Fist gesture, `App.tsx` calls `handleGrabAction()` and `simulateGrab()` directly. It bypasses the `#btn-grab` click listener in `index.html`, which is responsible for transitioning screens, initializing the outward repeller, and making `#progress-screen` visible.
*   **Decision**: 
    - In `App.tsx`'s hand results callback, instead of invoking `handleGrabAction()` and `simulateGrab()` directly, programmatically trigger a click on the DOM element: `document.getElementById('btn-grab')?.click()`.
    - This routes the gesture event through the exact same visual setup and signaling pipeline as a physical button click.
    - As a defensive fallback, ensure `window.updateSenderProgress` asserts the visibility of `#progress-screen`.

### 3.3. Issue 3: Remove Receiver Left Sweep Animation
*   **Root Cause**: The receiver's progress UI display is nested inside the callback of `animateIncomingSphere()`, which draws a white comet from the left edge over 1.5 seconds.
*   **Decision**: 
    - In `index.html`'s `startReceive()` function, remove the call to `animateIncomingSphere()`.
    - Call `showReceiveProgress(filename, totalBytes)` directly, bypassing the 1.5s visual delay.
    - Retain the `animateIncomingSphere` definition in `index.html` as a dead function to avoid compilation crashes.

### 3.4. Issue 4: Missing Drop Button on Bidirectional Transfer Role Swap
*   **Root Cause**: When a transfer completes or is cancelled, `resetWebRTCConnection()` in `App.tsx` resets the WebRTC objects, but leaves `isSource = true` (or other stale states) on the previous sender. If that device is now the receiver, its control panel remains hidden because the React state still considers it the sender.
*   **Decision**: 
    - Update `resetWebRTCConnection()` in `App.tsx` to explicitly clear the following React states (and their corresponding ref pointers):
        - `isSource` / `isSourceRef.current` $\rightarrow$ `false`
        - `isGlobalLocked` / `isGlobalLockedRef.current` $\rightarrow$ `false`
        - `incomingFile` / `incomingFileRef.current` $\rightarrow$ `null`
        - `isGrabbedPermanent` $\rightarrow$ `false`
        - `selectedFiles` / `selectedFilesRef.current` $\rightarrow$ `[]`

### 3.5. Issue 5: Support Multi-file Batch Transfers
*   **Root Cause**: When a file completes, the receiver plays a 1.2s ripple and displays the `#receive-success` overlay. In a batch, the sender immediately advances to the next file and sends `FILE_META`. The receiver sets up the new file, but the progress UI is hidden underneath the success screen.
*   **Decision**:
    - Add `batchIndex` and `batchCount` to the `FILE_META` metadata payload sent by the sender.
    - Propagate these parameters from `App.tsx` into `window.onFileReceivedSuccess({ name, size, url, batchIndex, batchCount })`.
    - In `completeReceive()` in `index.html`, check if the file is the last in the batch: `const isLast = (batchIndex + 1) >= batchCount`.
    - If `isLast` is `true`, play the ripple animation and display the `#receive-success` screen.
    - If `isLast` is `false` (intermediate file), add the file to the drawer immediately, show a Toast notification (`Received file X of Y`), and keep the progress panel ready for the next file stream without displaying the success overlay.

### 3.6. Issue 6: Remove File Size Warning Modal
*   **Root Cause**: The IIFE function `patchGrabButton` in `index.html` intercepts clicks on `#btn-grab` and intercepts the flow if any file in the queue is $\ge$ 500MB to display `lfModal`.
*   **Decision**: 
    - Wipe or empty the body of the `patchGrabButton` IIFE in `index.html` so it returns immediately without attaching any intercepting event listeners.

### 3.7. Issue 7: Stuck Visual States After Completion/Cancel
*   **Root Cause**: On success, the receiver is left in `#receiver-screen` (which has no controls once the room is unlocked). On `global-unlock`, `App.tsx` only transitions back to the sender screen if the success screen is NOT visible. When the success screen is dismissed, `dismissSuccess()` hides it but doesn't transition the screen. On cancellation, the receiver is transitioned back to the inactive `#receiver-screen` state.
*   **Decision**:
    - Expose `window._socketIsLocked = () => isGlobalLockedRef.current` in `App.tsx`.
    - Update `dismissSuccess()` in `index.html` to check `_socketIsLocked()`. If the room is unlocked, trigger `window.transitionToSender(code)` to return to the shared workspace.
    - Add a "Done" button to the `#receive-success` screen that calls `dismissSuccess()` to allow instant manual dismissal.
    - Update `window.onTransferCancelled` in `index.html` to check `_socketIsLocked()`. If unlocked, call `transitionToSender(roomCode)` instead of `transitionToReceiver(roomCode)`.

### 3.8. Issue 8: Keep Received Files Toggle Visible Symmetrically
*   **Root Cause**: `transitionToSender` in `index.html` explicitly removes the `visible` class from the `#files-panel-toggle` button.
*   **Decision**:
    - Remove the line `document.getElementById('files-panel-toggle')?.classList.remove('visible');` from `transitionToSender` in `index.html`.
    - Modify `updatePanelToggle()` in `index.html` to dynamically control the visibility class:
      ```javascript
      function updatePanelToggle() {
        const count = rxFiles.length;
        document.getElementById('files-count').textContent = count;
        const toggleBtn = document.getElementById('files-panel-toggle');
        if (toggleBtn) {
          if (count > 0) toggleBtn.classList.add('visible');
          else toggleBtn.classList.remove('visible');
        }
      }
      ```
    - Update `transitionToReceiver` in `index.html` to call `updatePanelToggle()` instead of forcing visibility.

---

## 4. Sequence & Dependencies
1.  **Expose lock status & reset state in React (`src/App.tsx`)**: Establish the data structure parameters (`batchIndex`, `batchCount`) and clear residuals.
2.  **Align gesture grabbing in React (`src/App.tsx`)**: Re-route the MediaPipe callback to a DOM click.
3.  **Update screen transition rules (`index.html`)**: Remove visibility overrides and wire up the dismiss checks.
4.  **Bypass sweep animation & size limits (`index.html`)**: Cut the visual latency and remove warnings.
5.  **Multi-file completion routing (`index.html` & `src/App.tsx`)**: Wire up conditional success screens based on batch counters.

---

## 5. Test Scenarios

### 5.1. Unit Verification (Checklists)

#### Scenario A: Weak Connection Startup
1. Disconnect the signaling server.
2. Load the client page. Enter room code and click **Join**.
3. Verify: No blank screen. The status pill says "Not Connected", and a warning `"Connecting to server..."` appears in the error field.
4. Start signaling server.
5. Verify: The client automatically resolves connection and joins the room.

#### Scenario B: Gesture Grab
1. Select a file on Device A.
2. Place hands in view of camera and perform a curling Fist gesture.
3. Verify: Device A triggers the shockwave, transitions to `#progress-screen`, starts the outward repeller canvas particles, and speed metrics update.

#### Scenario C: Direct Progress Transition
1. Initiate a transfer to Device B.
2. Verify: Device B's progress screen triggers instantly upon receiving the first packet, without the 1.5s white comet light sweep.

#### Scenario D: Bidirectional Role Swapping
1. Transfer a file from Laptop to Phone. Complete transfer and dismiss success states.
2. Select a file on Phone. Click **Send** (grab).
3. Verify: Laptop displays the **Drop** button. Click **Drop** and verify transfer completes successfully.

#### Scenario E: Multi-file Batch Transfers
1. Select 3 files on Device A. Click **Send**.
2. Verify: Device B shows progress for File 1, transitions immediately to progress for File 2 without showing a success overlay, and does the same for File 3.
3. Verify: Device B only displays the success screen after File 3 completes.

#### Scenario F: Size Warning Bypass
1. Select a 600MB file on Device A. Click **Send**.
2. Verify: The transfer begins immediately. No warning dialog is displayed.

#### Scenario G: Symmetrical Idle Restoration
1. Complete a transfer. Dismiss the success screen (wait 6s or click Done).
2. Verify: The receiver client transitions back to `#sender-screen`, displaying the drag-and-drop workspace.
3. Cancel a transfer mid-flight. Verify both clients return to `#sender-screen`.

#### Scenario H: Received Files Drawer
1. Transfer a file.
2. Go back to sender screen (idle workspace).
3. Verify: The files panel toggle button remains visible at the bottom of the screen.
4. Click **Clear Files** in the drawer. Verify the files toggle button disappears.
