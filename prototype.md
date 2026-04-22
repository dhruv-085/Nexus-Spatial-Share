# 🧪 Prototype Blueprint: Nexus Web-Link

## 1. Goal
To successfully transfer a text string (clipboard) and a small image from a **Mobile Browser** to a **Desktop Browser** using only a "Fist" gesture to grab and an "Open Palm" gesture to receive over a Local Area Network (LAN).

---

## 2. Prototype Tech Stack
*   **Language:** JavaScript (ES6+) / TypeScript
*   **Hand Tracking:** [MediaPipe Hands](https://google.github.io/mediapipe/solutions/hands.html)
*   **Signaling Server:** Node.js with Socket.io (To pair the two devices).
*   **P2P Transfer:** WebRTC (DataChannel API) for direct LAN speed.
*   **Hosting:** Localhost (via local IP or tunnel) for testing.

---

## 3. The Workflow (Step-by-Step)

### Phase 1: The "Handshake" (Pairing)
1.  **Open URL:** Open the web app on both Laptop and Phone.
2.  **Room Join:** The Laptop generates a 4-digit code (e.g., `8822`). The Phone enters this code.
3.  **Socket Connection:** Both devices are now in a "Virtual Room" on your Node.js server. They exchange "WebRTC Offers" to establish a direct P2P connection.
4.  **Privacy:** Browsers ask for Camera Permission. User clicks "Allow."

### Phase 2: The "Vision" (Gesture Logic)
We will use the **Landmark Distance** method to detect gestures:
*   **Fist Detection (Grab):** If the distance between the `INDEX_FINGER_TIP` and the `WRIST` is below a certain threshold, the state becomes `GRABBED`.
*   **Palm Detection (Drop):** If all five finger tips are at a maximum distance from the `WRIST`, the state becomes `READY_TO_RECEIVE`.

### Phase 3: The "Transfer" (Execution)
1.  **On Phone:** User selects an image on the webpage.
2.  **The Grab:** User makes a **Fist** in front of the phone camera.
    *   *Visual:* The image on the phone screen gets a "Blue Glow."
    *   *Signal:* Phone sends `socket.emit('grabbed')` to the Laptop.
3.  **The Drop:** User moves to the Laptop and shows an **Open Palm**.
    *   *Visual:* The Laptop screen shows a "Receiving..." animation.
    *   *Action:* The WebRTC DataChannel pushes the file bits directly from Phone $\rightarrow$ Laptop.
4.  **Result:** The image appears on the Laptop screen and triggers a "Download."

---

## 4. Technical Implementation Details

### A. The "Fist" Logic (Pseudo-code)
```javascript
// Calculate if hand is a fist
function isFist(landmarks) {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const palmBase = landmarks[0];

  const distance = Math.sqrt(
    Math.pow(indexTip.x - palmBase.x, 2) + 
    Math.pow(indexTip.y - palmBase.y, 2)
  );

  return distance < 0.15; // Threshold for a closed hand
}
```

### B. The P2P Pipe (WebRTC)
To ensure **LAN Speed**, we skip the server for the file itself:
```javascript
const dataChannel = peerConnection.createDataChannel("fileTransfer");

// Sending the file
dataChannel.send(fileBlob);

// Receiving the file
dataChannel.onmessage = (event) => {
  const receivedBlob = new Blob([event.data]);
  const url = URL.createObjectURL(receivedBlob);
  document.getElementById('display').src = url;
};
```

---

## 5. Trial & Testing Milestones

| Milestone | Task | Success Criteria |
| :--- | :--- | :--- |
| **M1** | Device Pairing | Laptop and Phone can send a "Hello" text via Sockets. |
| **M2** | Gesture Accuracy | Console logs "FIST" or "PALM" with 90% accuracy in normal light. |
| **M3** | The "Signal" | Laptop screen turns Green only when Phone makes a Fist. |
| **M4** | P2P Transfer | A 1MB image transfers in < 1 second over local Wi-Fi. |

---

## 6. Prototype Limitations
*   **Browser Backgrounding:** The tab must be open and active.
*   **HTTPS Requirement:** Camera access requires a secure context.
*   **Visuals:** Simple CSS transitions for the MVP.

---
