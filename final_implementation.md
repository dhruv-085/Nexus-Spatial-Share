# Nexus Spatial Share: Final Implementation Roadmap

This document serves as the definitive architectural blueprint and workflow guide for **Nexus Spatial Share**. It details the end-to-end logic of the system and provides a strategic path toward a Minimum Viable Product (MVP).

---

## 1. The Core Workflow (Step-by-Step)

The "Magic" of Nexus lies in the seamless transition between physical motion and digital data transfer.

### Phase A: Selection & The "Grab" (Mobile)
1.  **Selection:** The user selects a file (image, document, or text) via the mobile app's file picker or "Share" intent.
2.  **Activation:** The mobile camera activates a small, low-power overlay.
3.  **Gesture Detection:** MediaPipe monitors hand landmarks. When the distance between the fingertips and the palm center shrinks below a threshold, a **"Grab Event"** is triggered.
4.  **Visual Feedback:** A Three.js/Flutter Scene particle vortex appears around the fist, and the file icon "shrinks" into the hand.
5.  **Signaling:** The phone sends a lightweight WebSocket message to the Node.js server: `[Device_A] is STATUS_HOLDING_FILE`.

### Phase B: Spatial Discovery (LAN)
1.  **Network Awareness:** All devices on the same Wi-Fi (discovered via mDNS) receive the "Holding" signal.
2.  **Desktop Response:** The Desktop app (Electron) activates its webcam *only* when it knows a file is "held" nearby.
3.  **Visual Cue:** The edges of the desktop monitor glow (e.g., a soft blue pulse), indicating it is ready to receive.

### Phase C: The "Throw" & Directional Logic
1.  **Vector Calculation:** As the user moves their phone toward a screen, the **Inertial Measurement Unit (IMU)** captures:
    *   `Compass Heading` (Which way am I facing?)
    *   `Linear Acceleration` (How fast am I moving the phone?)
2.  **Targeting:** The Signaling server compares the phone's vector with the pre-registered relative positions of laptops in the room. It selects the most likely recipient.

### Phase D: The "Drop" & Transfer
1.  **Gesture Detection:** The Desktop webcam detects an **"Open Palm"** gesture in its field of view.
2.  **P2P Handshake:** The Desktop sends a `REQUEST_DOWNLOAD` signal to the specific Phone holding the file.
3.  **WebRTC Pipe:** A direct **RTCDataChannel** is established. The file is streamed chunk-by-chunk over the local network (bypassing the internet/cloud).
4.  **Completion:** The file "rains" down from the top of the desktop screen into the user's Downloads folder with a landing animation.

---

## 2. MVP Strategy (The Path to Version 1.0)

To avoid "feature creep," the MVP focuses on the **Core Pipe** and **Basic Gesture Recognition**.

### Step 1: The "Invisible Cable" (Weeks 1-2)
*   **Goal:** Establish a reliable P2P connection.
*   **Action:** Build a basic Node.js signaling server and a simple Flutter/Electron interface.
*   **Success Metric:** Clicking a "Send" button on the phone successfully transfers a 10MB file to the desktop over local Wi-Fi using WebRTC.

### Step 2: The "Vision Trigger" (Weeks 3-4)
*   **Goal:** Replace the button with a gesture.
*   **Action:** Integrate MediaPipe.
    *   **Mobile:** Detect "Fist" to start the transfer.
    *   **Desktop:** Detect "Open Palm" to accept the transfer.
*   **Success Metric:** A file moves from Phone to Desktop triggered solely by hand gestures, with no manual clicks.

### Step 3: The "Clipboard Tunnel" (Week 5)
*   **Goal:** Implement text sharing.
*   **Action:** Use Electron's clipboard API to "Grab" text from the desktop and send it to the phone's clipboard.
*   **Success Metric:** Highlighting text on a PC and making a "Grab" gesture copies that text to the phone's clipboard automatically.

### Step 4: UI Polish & Feedback (Week 6)
*   **Goal:** Make it feel "Spatial."
*   **Action:** Add the basic "Vortex" and "Falling" animations.
*   **Success Metric:** The user receives visual confirmation that the gesture was recognized before the transfer starts.

---

## 3. Technical Constraints & Solutions

| Constraint | Solution |
| :--- | :--- |
| **Privacy Concerns** | Webcams are **OFF** by default. They only trigger when the Signaling server announces a "Grab" event. |
| **Battery Drain** | MediaPipe runs in short bursts. Once the transfer starts, the camera shuts down immediately. |
| **Network Isolation** | Use **mDNS (ZeroConf)** so devices can find each other without requiring the user to type in IP addresses. |
| **Cross-Platform** | Flutter (Mobile) and Electron (Desktop) ensure the same logic works on Android/iOS and Windows/macOS. |

---

## 4. Future Enhancements (Post-MVP)
*   **Time Capsule:** Storing "held" files in a local SQLite DB if the target device is offline.
*   **Multi-Device Broadcast:** "Throwing" a file to three laptops simultaneously.
*   **Haptic Feedback:** Using advanced vibration patterns on mobile to simulate the "weight" of a file being held.

---
**End of Document**
