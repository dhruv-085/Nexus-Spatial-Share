# Nebulo Share

Nebulo Share is a private, high-speed, peer-to-peer file sharing web application that pairs devices in seconds to beam files directly over an encrypted WebRTC connection beyond the cloud. Transfer files without third-party servers, storage limits, or tracking.

---

## ✨ Key Features

1. **Direct Peer-to-Peer Beaming**:
   - **Send**: Select files and beam them directly to your peer.
   - **Receive**: Stand by and save incoming files directly to local storage.

2. **Custom High-Speed Transfer Engine**:
   - **Striped Multi-Channel WebRTC**: Splits transmission over 3 concurrent, high-throughput binary data channels plus a dedicated control channel for ACKs/NACKs and metadata.
   - **Adaptive sliding window Flow Control**: Measures RTT dynamically. Adjusts concurrency automatically:
     - **LAN profile**: 3 striped channels, 64-chunk window ceiling (RTT <= 5ms).
     - **Wi-Fi profile**: Single channel, 32-chunk window ceiling (RTT > 5ms) to prevent radio wave collision.
   - **Congestion Avoidance**: Uses AIMD (Additive Increase / Multiplicative Decrease) algorithm to prevent SCTP socket backpressure.

3. **Zero-Heap Disk Streaming**:
   - Streams chunks dynamically using the browser's **File System Access (FSA) API** directly to the target location. This prevents storing massive buffers in RAM (avoiding browser tab crashes for files > 2GB).
   - Falls back to an optimized OPFS/RAM buffer and automatic download link triggers in non-FSA environments (like Safari or mobile devices).

4. **Robust Integrity & Resiliency**:
   - Compiles and loads a **Parallel WASM xxhash Checksum Worker Pool** to offload CPU-intensive integrity checks from the main UI thread.
   - Automatically handles React StrictMode dual-mount socket resets and features a 30-second zombie client clean-up process on the signaling server.

5. **"The Digital Architect" Design System**:
   - Aesthetic dark mode based on HSL background separation (no harsh borders).
   - Notch safe-area compensation for mobile browsers (`viewport-fit=cover`).
   - Symmetrical particle repelling/attracting visuals running at 60 FPS on canvas.

---

## 🚀 Getting Started

### 📋 Prerequisites
- **Node.js** (v18 or higher recommended)
- A modern web browser (Chrome, Edge, Firefox, or Safari)

### 🛠️ Installation & Setup
1. **Clone the Repository**
   ```bash
   git clone https://github.com/dhruv-085/Nexus-Spatial-Share.git
   cd Nexus-Spatial-Share
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Secure Context Configuration (Optional but Recommended)**
   File System Access APIs require a **Secure Context** (`https://` or `localhost`). If you want to connect a phone to your computer's local IP, running the server over HTTPS is recommended.
   To run in HTTPS locally:
   - Generate local SSL certificates (`cert.key` and `cert.crt`) in the root directory.
   - You can use tools like `mkcert` or OpenSSL:
     ```bash
     openssl req -x509 -newkey rsa:2048 -keyout cert.key -out cert.crt -days 365 -nodes
     ```
   - The server will automatically detect `cert.key` and `cert.crt` and start in **HTTPS mode**.

### 💻 Running the App
- **Development Server** (with Vite HMR and Express signaling server):
  ```bash
  npm run dev
  ```
  The app will run at `http://localhost:3000` (or `https://localhost:3000` if certificates are generated).

- **Production Build**:
  ```bash
  npm run build
  npm start
  ```

---

## 🛠️ Architecture & Tech Stack
- **Frontend**: React 19, Tailwind CSS, Lucide Icons, Vite
- **Signaling Broker**: Node.js/Express, Socket.io, ExpressPeerServer (PeerJS)
- **WebRTC Data Engine**: Native RTCPeerConnection and RTCDataChannel, `lz4js` compression, WASM `xxhash` for chunk checksum hashing

