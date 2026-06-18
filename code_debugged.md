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
