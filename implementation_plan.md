---
title: Nexus Spatial — UI Integration Plan
type: feat
status: completed
date: 2026-06-17
origin: project_overview.md
---

# Nexus Spatial — UI Integration Plan (Rev 3)

## Summary

Replace the temporary test UI with the fully polished **Chapter 8 UI** (`UI UX files/nexus_spatial_chapter8_final.html`) while keeping **100% of the existing backend, transfer, and WebRTC logic intact**. This plan establishes the integration bridge between headless React states and the static DOM, configures symmetrical shared workspaces, maps OPFS file saving fallback, and removes conflicting legacy script blocks and ZXing scanner code.

---

## Problem Frame

The project has a highly optimized, high-speed transfer engine and MediaPipe gesture recognition controller running in React (`src/App.tsx`), but the user interface is a basic, temporary HTML template. The premium Chapter 8 visual layout has been designed as a static HTML template with drift particles, node pairing globes, and custom modal overlays. We need to replace the visual shell with the premium Chapter 8 design without introducing any modifications to the core functional layer of the backend, WebRTC, or transfer engine.

---

## Requirements

- **R1. Backend signaling stability**: The signaling server (`server.ts`) must remain untouched except for a minor patch to emit the room code.
- **R2. Headless transfer execution**: The file transfer engine (`src/lib/TransferEngine.ts`) must run headlessly, controlled via React callbacks.
- **R3. Invisible camera lifecycle**: Gesture webcam capture and MediaPipe Hands landmark tracking must run offscreen in an invisible React container.
- **R4. Premium layout migration**: The HTML file `UI UX files/nexus_spatial_chapter8_final.html` must replace the root `index.html` as the visual layout.
- **R5. Collision removal**: Duplicate Socket.io and WebRTC script tags (legacy Chapter 7 code blocks) inside the HTML shell must be stripped to prevent double connections.
- **R6. ZXing de-registration**: The `zxing-js` camera QR scanning libraries must be removed and scanner events disabled to prevent runtime `ReferenceError` crashes.
- **R7. Symmetrical layout**: Both sender and receiver must see the same shared workspace (`#sender-screen`) with `#btn-drop` added to support receiver workflows.
- **R8. WebRTC dot & telemetry integration**: Sockets and peer connection states must drive the UI status dots, and chunk speeds must drive the `window.ParticleSystem` progress animations.
- **R9. OPFS file storage**: Gesture-based downloads must write directly to the Origin Private File System (OPFS), and the drawer (`#files-panel`) must populate dynamically from the OPFS storage list.
- **R10. OTP digit pastings**: Room pairing input boxes (`#otp-0` to `#otp-3`) must support auto-advance focus and clipboard pasting of 4-character codes.

---

## Scope Boundaries

- **No camera-based QR scanning**: The "Scan QR" tab visual elements are kept for design integrity, but the webcam scanning logic is disabled (zxing-js CDN removed). Pairing relies on manual code input or displaying QR codes.
- **Deactivation of simulated triggers**: Developer testing buttons (`#btn-simulate`, `#rx-dev-panel`) are stripped.
- **Deactivation of manual role picker**: The manual `#role-picker` panel is permanently hidden. Role assignments are automatically handled by the server.

---

## Context & Research

### Relevant Code and Patterns
- `src/App.tsx`: Main React controller mapping DOM listeners and state logic.
- `src/lib/TransferEngine.ts`: Binary chunking, sliding windows, and OPFS fallback writes.
- `UI UX files/nexus_spatial_chapter8_final.html`: Source layout and particle design scripts.

### Institutional Learnings
- **React StrictMode Dual-Mount**: React mounts twice in dev, triggering duplicate socket creation. The server handles this by filtering duplicate joins, but event listeners must be properly bound and disposed in `useEffect` returns to prevent duplicate binding.
- **Secure Context Contexts**: OPFS and mediaDevices require a secure HTTPS context (`window.isSecureContext`) to run on mobile browsers.

---

## Key Technical Decisions

- **Headless React Orchestration**: React manages the WebRTC connections, socket states, and MediaPipe hands processing in a hidden mount container. It controls the Chapter 8 HTML DOM elements by calling `window.*` API bridge callbacks.
- **OPFS Async Storage Fallback**: Since gesture-based drop actions cannot trigger a native user file prompt (FSA `showSaveFilePicker` requires a direct user click), receiver downloads are written directly to OPFS. Users then download the file from the files panel drawer using standard browser triggers.
- **Visual Symmetrical Workspace**: Instead of switching screen layers, both users share `#sender-screen`. The transmitter selects files, enabling the "Grab" button. Once grabbed, the receiver's screen is locked and their "Drop" button enables.

---

## High-Level Technical Design

```
                     ┌───────────────────────────────┐
                     │          index.html           │
                     │  (Chapter 8 visual shell)     │
                     └──────────────┬────────────────┘
                                    │ window.* bridge API callbacks
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                             src/App.tsx                            │
│                      (Headless React orchestrator)                 │
│  ┌─────────────────────────┐             ┌──────────────────────┐  │
│  │   MediaPipe Hands (Ref) │             │ TransferEngine (Ref) │  │
│  └───────────▲─────────────┘             └───────────▲──────────┘  │
│              │ video stream                          │ binary data │
│  ┌───────────┴─────────────┐             ┌───────────┴──────────┐  │
│  │ Invisible <video> mount │             │ RTCDataChannel P2P   │  │
│  └─────────────────────────┘             └──────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Units

### U1. server.ts room status extension
- **Goal**: Let `server.ts` report the room code inside `room-status` payloads.
- **Requirements**: R1
- **Dependencies**: None
- **Files**:
  - Modify: `server.ts`
- **Approach**: Update signaling server so that both wait and ready states report the room code string:
  ```ts
  socket.emit('room-status', { status: 'ready', role: 'offerer', code: roomCode });
  ```
- **Test scenarios**:
  - Happy path: First client joins room A and receives `code: 'A'` in room-status wait event.
  - Integration: Second client joins, triggering room-status ready with the same code on both sockets.

### U2. Compile and clean index.html shell
- **Goal**: Extract Chapter 8 HTML as the main `index.html` and strip legacy blocks.
- **Requirements**: R4, R5, R6
- **Dependencies**: None
- **Files**:
  - Create: `index.html` (replaces root minimal Vite shell)
- **Approach**:
  - Extract head, CSS styling, and visual structure from `UI UX files/nexus_spatial_chapter8_final.html`.
  - Delete Chapter 7 duplicate script block containing socket connections and basic slice assemblies.
  - Remove zxing-js scanner CDN scripts. Comment out the QR webcam scanning loops inside Chapter 2 script tags.
  - Inject React mount root `#root` and Vite module script before `</body>`.
- **Test scenarios**:
  - Happy path: Compiling index.html succeeds. Visual inspect shows particles drifting without console errors.
  - Edge case: Clicking "Scan QR" tab switches views but does not attempt camera scan or throw ReferenceErrors.

### U3. Add Drop button & symmetrical workspace CSS
- **Goal**: Inject `#btn-drop` next to `#btn-grab` and apply symmetrical layouts.
- **Requirements**: R7
- **Dependencies**: U2
- **Files**:
  - Modify: `index.html`
- **Approach**:
  - Insert `#btn-drop` markup in the `#control-panel` element.
  - Apply custom drop button enabled pulsing shadow classes and disabled styling matching the design.
  - Hide manual `#role-picker` layout using inline style `"display:none !important"`.
- **Test scenarios**:
  - Happy path: Both buttons appear side-by-side. Drop button is disabled initially.
  - Edge case: Buttons follow high-tonal surface design system tokens.

### U4. React-to-UI bridge event bindings
- **Goal**: Bind visual elements to headless states in `App.tsx`.
- **Requirements**: R3, R8
- **Dependencies**: U3
- **Files**:
  - Modify: `src/App.tsx`
- **Approach**:
  - Render a hidden `<video>` and `<canvas>` container in the React return JSX.
  - Define `useEffect` hooks monitoring states (`isSocketConnected`, `joined`, `connected`, etc.) to drive window callbacks:
    - `window.updateGrabButtonState(hasFiles, isLocked, isSource)`
    - `window.updateDropButtonState(hasIncoming, isLocked, isSource)`
  - Register DOM listeners for `#btn-join`, `#btn-create`, `#btn-grab`, `#btn-drop`, `#btn-cancel`, `#btn-leave`, etc., inside a React `useEffect` callback block.
- **Test scenarios**:
  - Happy path: Inputting OTP room code and clicking join successfully pair the devices.
  - Happy path: Selecting a file enables the Grab button.
  - Happy path: WebRTC success transitions status dot indicator from grey to green.

### U5. OPFS file storage & files drawer sync
- **Goal**: Populate received files lists and trigger downloads via OPFS fallback.
- **Requirements**: R9
- **Dependencies**: U4
- **Files**:
  - Modify: `src/App.tsx`, `src/lib/TransferEngine.ts`
- **Approach**:
  - Ensure gesture drops stream binary chunks straight to OPFS storage.
  - Wire the bottom drawer list (`#files-panel`) to sync dynamically with React `receivedFiles` list.
  - Bind click on `#btn-download-main` to trigger the browser local download prompt for OPFS files.
  - Bind `#btn-dl-all` and `#btn-clear-files` to trigger batch saves and folder wipes inside OPFS.
- **Test scenarios**:
  - Happy path: Gesture drop writes files to OPFS. Count increments on files drawer badge.
  - Happy path: Expanding files panel displays file list; clicking download exports files to local disk.

### U6. OTP clipboard paste & focus traversal
- **Goal**: Add user helpers to room pairing inputs.
- **Requirements**: R10
- **Dependencies**: U2
- **Files**:
  - Modify: `index.html` (script section)
- **Approach**:
  - Attach input listeners to `#otp-0` to `#otp-3` to advance focus as each character is typed.
  - Attach keydown backspace listeners to retreat focus.
  - Attach paste listener to `#otp-0` that reads clipboard, splits 4 digits across inputs, and submits join automatically.
- **Test scenarios**:
  - Happy path: Typing digits moves focus to subsequent boxes automatically.
  - Happy path: Pasting "7890" fills inputs and automatically joins the room.

---

## System-Wide Impact

- **Interaction graph**: State changes in `App.tsx` propagate via `window` callbacks to the DOM shell. If a window hook is undefined, it must degrade gracefully instead of throwing exceptions.
- **State lifecycle risks**: When components unmount (e.g. leaving room), DOM click listeners must be detached, and window callbacks must be set to null to avoid leaking memory and running callbacks on dead sockets.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Missing `QRCode` library crashes room generation | Keep the `updateQR` fallback string writing routine active to write text if library fails. |
| Gesture drops fail on restricted browser permissions | Ensure Secure Context is enforced, and fallback to OPFS if File System Access permission is denied. |
| Duplicate Socket events on dev StrictMode | Maintain unique reference checks in React socket initialisation to avoid double room pairings. |

---

## Sources & References

- **Origin document**: [project_overview.md](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/project_overview.md)
- Related code: [App.tsx](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/App.tsx), [TransferEngine.ts](file:///D:/Projects/Nexus%20Spatial%20Share/Website%20Code/nexus-spatial-share/src/lib/TransferEngine.ts)
