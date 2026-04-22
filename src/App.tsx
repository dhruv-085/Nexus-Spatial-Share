import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Smartphone, Laptop, Send, CheckCircle2, AlertCircle, Camera, Hand, File as FileIcon, Upload, Download } from "lucide-react";
import { cn } from "@/src/lib/utils";
import { Hands, Results, HAND_CONNECTIONS } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { TransferEngine, TransferTelemetry, CHUNK_SIZE, HEADER_SIZE } from './lib/TransferEngine';

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState("");
  const [isGrabbed, setIsGrabbed] = useState(false);
  const [isGrabbedPermanent, setIsGrabbedPermanent] = useState(false);
  const isGrabbedPermanentRef = useRef(false);
  const [isSocketConnected, setIsSocketConnected] = useState(false);

  const [isDropped, setIsDropped] = useState(false);
  const [isGlobalLocked, setIsGlobalLocked] = useState(false);
  const [isSource, setIsSource] = useState(false);

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [transferProgress, setTransferProgress] = useState(0);
  const [isTransferring, setIsTransferring] = useState(false);
  const [telemetry, setTelemetry] = useState<TransferTelemetry | null>(null);
  const transferEngineRef = useRef<TransferEngine | null>(null);
  const [incomingFile, setIncomingFile] = useState<{ name: string, type: string, size: number } | null>(null);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [receivedFiles, setReceivedFiles] = useState<{ name: string, blob: Blob, id: string }[]>([]);
  // File System Access API: one directory handle for the entire session's batch download
  const saveDirectoryHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const hasSaveDirectoryRef = useRef(false);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isMediaPipeDead, setIsMediaPipeDead] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const connRef = useRef<RTCDataChannel[]>([]);
  const controlConnRef = useRef<RTCDataChannel[]>([]);
  const isTransferringFastRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handsRef = useRef<Hands | null>(null);
  const lastGestureRef = useRef<string>("none");
  const requestRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileChunksRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef(0);
  
  // Refs for callbacks to avoid stale closures
  const connectedRef = useRef(false);
  const roomCodeRef = useRef("");
  const joinedRef = useRef(false);

  const isGlobalLockedRef = useRef(false);
  const isSourceRef = useRef(false);
  const incomingFileRef = useRef<{ name: string, type: string, size: number } | null>(null);
  const selectedFilesRef = useRef<File[]>([]);
  const currentFileIndexRef = useRef(0);
  const isTransferringRef = useRef(false);
  const transferRequestedRef = useRef(false);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    joinedRef.current = joined;
  }, [joined]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    isGlobalLockedRef.current = isGlobalLocked;
  }, [isGlobalLocked]);

  useEffect(() => {
    isSourceRef.current = isSource;
  }, [isSource]);

  useEffect(() => {
    selectedFilesRef.current = selectedFiles;
  }, [selectedFiles]);

  useEffect(() => {
    currentFileIndexRef.current = currentFileIndex;
  }, [currentFileIndex]);

  // Eager MediaPipe warm-up: preload model so camera is instantly ready
  const mediaPipeWarmedUp = useRef(false);
  const warmUpMediaPipe = useCallback(async () => {
    if (mediaPipeWarmedUp.current || !handsRef.current) return;
    try {
      // Create a tiny offscreen canvas and send it to trigger model download+compilation
      const offscreen = document.createElement('canvas');
      offscreen.width = 2;
      offscreen.height = 2;
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 2, 2);
      }
      await handsRef.current.send({ image: offscreen });
      mediaPipeWarmedUp.current = true;
      console.log('MediaPipe Hands model warmed up and ready.');
    } catch (err) {
      console.warn('MediaPipe warm-up failed (non-fatal):', err);
    }
  }, []);

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    // Initialize MediaPipe Hands eagerly
    const hands = new Hands({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
      },
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    hands.onResults((results) => {
      // Always call with latest context
      onResults(results);
    });
    handsRef.current = hands;

    // Immediately trigger model download + WASM compilation
    // This runs in background so model is ready by the time camera is needed
    warmUpMediaPipe();

    socket.on("connect", () => {
      console.log("Connected to signaling server");
      setIsSocketConnected(true);
      // Re-join room if we were already in one
      if (roomCodeRef.current.length === 4) {
         socket.emit("join-room", roomCodeRef.current);
      }
    });

    socket.on("room-status", async ({ status, role }) => {
      console.log(`[Signaling] Room status: ${status}, role: ${role}`);
      if (status === 'waiting') {
        setJoined(true);
      } else if (status === 'ready') {
        setJoined(true);
        if (role === 'offerer') {
          await setupOfferer();
        } else {
          await setupAnswerer();
        }
      } else if (status === 'full') {
        setMessages(prev => [...prev, "SYSTEM: Room is full!"]);
      }
    });

    socket.on("offer", async ({ sdp }) => {
      console.log("[Signaling] Received offer");
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit("answer", { roomId: roomCodeRef.current, sdp: answer });
      }
    });

    socket.on("answer", async ({ sdp }) => {
      console.log("[Signaling] Received answer");
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      if (pcRef.current && candidate) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("Error adding received ice candidate", e);
        }
      }
    });

    socket.on("peer-disconnected", () => {
      console.log("[Signaling] Peer disconnected, resetting room...");
      setMessages(prev => [...prev, "SYSTEM: Peer disconnected. Room reset."]);
      resetWebRTCConnection();
    });

    socket.on("global-lock", ({ sourceId }) => {
      console.log("CONSOLE: Received global-lock from server. Source:", sourceId);
      setIsGlobalLocked(true);
      const isMe = socket.id === sourceId;
      setIsSource(isMe);
      if (isMe) {
        setIsGrabbed(true);
        setIsGrabbedPermanent(true);
        setTimeout(() => setIsGrabbed(false), 2000);
      }
    });

    socket.on("global-unlock", () => {
      console.log("CONSOLE: Received global-unlock from server. Room is now free.");
      setIsGlobalLocked(false);
      setIsSource(false);
      setIsGrabbedPermanent(false);
      setIncomingFile(null);
      incomingFileRef.current = null;
      fileChunksRef.current = [];
      setTransferProgress(0);
      setIsDropped(true);
      setTimeout(() => setIsDropped(false), 2000);
      isGrabbedPermanentRef.current = false;
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from signaling server");
      setIsSocketConnected(false);
      setIsGrabbedPermanent(false);
      isGrabbedPermanentRef.current = false;
      if (transferEngineRef.current) {
        transferEngineRef.current.cancel();
        transferEngineRef.current = null;
      }
      isTransferringRef.current = false;
      isTransferringFastRef.current = false;
      setIsTransferring(false);
      transferRequestedRef.current = false;
      
      if (pcRef.current) {
         pcRef.current.close();
         pcRef.current = null;
      }
      connRef.current = [];
      controlConnRef.current = [];
      setConnected(false);
    });

    return () => {
      socket.disconnect();
      if (pcRef.current) {
        pcRef.current.close();
      }
      if (handsRef.current) {
        handsRef.current.close();
      }
      // Terminate transfer engine workers on unmount
      if (transferEngineRef.current) {
        transferEngineRef.current.cleanup();
        transferEngineRef.current = null;
      }
      // Reset FSA state
      saveDirectoryHandleRef.current = null;
      hasSaveDirectoryRef.current = false;
    };
  }, []);

  const startCamera = useCallback(async () => {
    if (isCameraActive || isMediaPipeDead) return;
    
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      setCameraError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          setIsCameraActive(true);
          
          let isProcessing = false;
          const processVideo = async () => {
            if (isMediaPipeDead) return;

            if (isTransferringFastRef.current) {
              requestRef.current = requestAnimationFrame(processVideo);
              return;
            }

            if (videoRef.current && handsRef.current && videoRef.current.srcObject && !isProcessing) {
              // Ensure video has valid dimensions to avoid MediaPipe WASM crashes
              if (videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
                isProcessing = true;
                try {
                  await handsRef.current.send({ image: videoRef.current });
                } catch (err: any) {
                  console.error("MediaPipe send error:", err);
                  // If it's a fatal WASM error, stop the loop
                  if (err.message?.includes("abort") || err.message?.includes("memory")) {
                    setIsMediaPipeDead(true);
                    setCameraError("Gesture recognition engine crashed. Please refresh the page.");
                    return;
                  }
                  // For non-fatal errors, skip a few frames
                  await new Promise(resolve => setTimeout(resolve, 200));
                } finally {
                  isProcessing = false;
                }
              }
            }
            
            if (videoRef.current && videoRef.current.srcObject && !isMediaPipeDead) {
              requestRef.current = requestAnimationFrame(processVideo);
            }
          };
          requestRef.current = requestAnimationFrame(processVideo);
        }
      } catch (err: any) {
        console.error("Camera access error:", err);
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          setCameraError("Camera permission denied. Please check your browser's address bar or settings to allow camera access for this site.");
        } else {
          setCameraError(`Camera access failed: ${err.message}`);
        }
      }
    } else {
      setCameraError("Your browser does not support camera access.");
    }
  }, [isCameraActive, isMediaPipeDead]);

  const stopCamera = useCallback(() => {
    if (!isCameraActive) return;
    
    console.log("Stopping camera and clearing canvas...");
    
    // Stop the animation loop
    if (requestRef.current) {
      cancelAnimationFrame(requestRef.current);
      requestRef.current = null;
    }

    // Stop the video stream
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }

    // Clear the canvas to prevent "freezing" on the last frame
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }

    setIsCameraActive(false);
  }, [isCameraActive]);

  useEffect(() => {
    // Camera should be ON if:
    // 1. I have files selected (I am potential source)
    // 2. The room is locked AND I am NOT the source (I am the potential target)
    // AND we are NOT currently transferring a file.
    // AND we have not grabbed the file yet.
    const shouldBeOn = joined && !isTransferring && !isGrabbedPermanent && (selectedFiles.length > 0 || (isGlobalLocked && !isSource));
    
    if (shouldBeOn) {
      startCamera();
    } else if (isCameraActive) {
      stopCamera();
    }
  }, [joined, selectedFiles, isGlobalLocked, isSource, startCamera, stopCamera, isCameraActive, isTransferring, isGrabbedPermanent]);

  const onResults = (results: Results) => {
    if (!canvasRef.current || !videoRef.current || !joinedRef.current) return;

    const canvasCtx = canvasRef.current.getContext("2d");
    if (!canvasCtx) return;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasRef.current.width, canvasRef.current.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      for (const landmarks of results.multiHandLandmarks) {
        // Improved Gesture Detection using distances from wrist
        const wrist = landmarks[0];
        
        // Fist Detection: Tips are closer to the wrist than the MCP joints (curled)
        const isFist = [8, 12, 16, 20].every(tipIdx => {
          const mcpIdx = tipIdx - 3;
          const tipDist = Math.sqrt(Math.pow(landmarks[tipIdx].x - wrist.x, 2) + Math.pow(landmarks[tipIdx].y - wrist.y, 2));
          const mcpDist = Math.sqrt(Math.pow(landmarks[mcpIdx].x - wrist.x, 2) + Math.pow(landmarks[mcpIdx].y - wrist.y, 2));
          return tipDist < mcpDist * 1.2; // Fingers are curled in
        });
        
        // Palm Detection: Tips are significantly further from the wrist than the MCP joints (extended)
        // Check if at least 3 fingers are extended for better reliability
        const extendedFingers = [8, 12, 16, 20].filter(tipIdx => {
          const mcpIdx = tipIdx - 3;
          const tipDist = Math.sqrt(Math.pow(landmarks[tipIdx].x - wrist.x, 2) + Math.pow(landmarks[tipIdx].y - wrist.y, 2));
          const mcpDist = Math.sqrt(Math.pow(landmarks[mcpIdx].x - wrist.x, 2) + Math.pow(landmarks[mcpIdx].y - wrist.y, 2));
          return tipDist > mcpDist * 1.4; // Fingers are extended out
        }).length;
        
        const isPalm = extendedFingers >= 3;

        // Visual Debugging on Canvas
        canvasCtx.fillStyle = "white";
        canvasCtx.font = "bold 20px sans-serif";
        let gestureText = "NONE";
        if (isFist) gestureText = "FIST (GRAB)";
        if (isPalm) {
          gestureText = "PALM (DROP)";
          if (isGlobalLockedRef.current) {
            setIsGrabbedPermanent(true);
            isGrabbedPermanentRef.current = true;
          }
        }
        canvasCtx.fillText(`GESTURE: ${gestureText}`, 20, 40);
        canvasCtx.fillText(`EXTENDED: ${extendedFingers}/4`, 20, 70);

        // Draw with feedback color
        let color = "#00FF00"; // Green for idle
        if (isFist) color = "#3b82f6"; // Blue for grab
        if (isPalm && isGlobalLockedRef.current && !isSourceRef.current) color = "#10b981"; // Emerald for drop
        if (isPalm && isSourceRef.current && isGlobalLockedRef.current) color = "#f59e0b"; // Amber for source (cannot drop)

        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color, lineWidth: 5 });
        drawLandmarks(canvasCtx, landmarks, { color: isFist ? "#ffffff" : "#FF0000", lineWidth: 2 });

        if (!isGlobalLockedRef.current) {
          // SYSTEM IS IDLE: Look for Grab (Fist)
          // ONLY trigger if a file is selected on THIS device
          if (isFist && lastGestureRef.current !== "fist" && selectedFilesRef.current.length > 0) {
            console.log("GESTURE: GRAB DETECTED - Files:", selectedFilesRef.current.length);
            lastGestureRef.current = "fist";
            handleGrabAction();
            simulateGrab();
          } else if (!isFist) {
            lastGestureRef.current = "none";
          }
        } else {
          // SYSTEM IS LOCKED: Data is in the tunnel
          if (!isSourceRef.current) {
            // I AM THE TARGET: Look for Drop (Palm)
            // Trigger if we see a palm. We'll handle the "no chunks" case inside handleDropAction
            if (isPalm && lastGestureRef.current !== "palm") {
              console.log("GESTURE: DROP DETECTED - Triggering drop action");
              lastGestureRef.current = "palm";
              handleDropAction();
            } else if (!isPalm) {
              // Reset palm gesture if hand is closed or moved
              if (lastGestureRef.current === "palm") {
                lastGestureRef.current = "none";
              }
            }
          }
          // I AM THE SOURCE: Ignore all gestures until unlocked
        }
      }
    }
    canvasCtx.restore();
  };

  // Get the current file to send (based on currentFileIndex)
  const getCurrentFile = useCallback((): File | null => {
    const files = selectedFilesRef.current;
    const idx = currentFileIndexRef.current;
    if (files.length === 0 || idx >= files.length) return null;
    return files[idx];
  }, []);

  const handleGrabAction = async () => {
    const fileToSend = getCurrentFile();
    if (!fileToSend) {
      console.log("CONSOLE: handleGrabAction aborted - no file selected");
      return;
    }
    
    try {
      const totalFiles = selectedFilesRef.current.length;
      const fileNum = currentFileIndexRef.current + 1;
      console.log(`CONSOLE: Grabbed file "${fileToSend.name}" (${fileNum}/${totalFiles})`);
      setMessages((prev) => [...prev, `SYSTEM: Grabbed file "${fileToSend.name}" (${fileNum}/${totalFiles}). Waiting for receiver to drop...`]);
      
      // Reset transfer state for new grab
      isTransferringRef.current = false;
      transferRequestedRef.current = false;
      
      // Only send metadata on grab. Transfer starts on drop.
      if (controlConnRef.current.length > 0 && connectedRef.current) {
        controlConnRef.current.forEach(c => c.send(JSON.stringify({
          type: "FILE_META",
          file: {
            name: fileToSend.name,
            type: fileToSend.type,
            size: fileToSend.size,
            totalChunks: Math.ceil(fileToSend.size / CHUNK_SIZE),
            chunkSize: CHUNK_SIZE
          }
        })));
      }
    } catch (err) {
      console.error("Grab action failed:", err);
      setSelectedFiles([]); // Clear on error to allow retry and turn off camera
      simulateDrop();
    }
  };

  const executeTransfer = async (fileOverride?: File, resumeManifest: number[] = []) => {
    const file = fileOverride || getCurrentFile();
    if (!file) {
      console.error("CONSOLE: Cannot send file: No file available");
      return;
    }

    if (!connRef.current || !connectedRef.current) {
      console.error("CONSOLE: Cannot send file: Peer connection not ready");
      return;
    }

    if (isTransferringRef.current) {
      console.log("CONSOLE: Transfer already in progress. Ignoring duplicate request.");
      return;
    }

    isTransferringFastRef.current = true;
    console.log(`CONSOLE: Starting transfer of ${file.name} (${file.size} bytes)`);
    isTransferringRef.current = true;
    setIsTransferring(true);
    
    const newEngine = createTransferEngine(connRef.current);
    newEngine.startTransfer(file, resumeManifest);
  };

  const handleDropAction = () => {
    // If I am the receiver, initiate the transfer
    if (!isSourceRef.current) {
      if (transferRequestedRef.current) {
        console.log("CONSOLE: Transfer already requested. Ignoring duplicate drop.");
        return;
      }

      console.log("CONSOLE: Drop gesture recognized on receiver. Requesting transfer.");
      transferRequestedRef.current = true;
      isTransferringRef.current = true;
      setIsTransferring(true);
      setMessages(prev => [...prev, "SYSTEM: Drop recognized. Downloading file..."]);
      
      // Notify the sender to start sending chunks
      if (controlConnRef.current.length > 0 && connectedRef.current) {
        console.log("CONSOLE: Sending START_TRANSFER to peer");
        controlConnRef.current.forEach(c => c.send(JSON.stringify({
          type: "START_TRANSFER",
          resumeManifest: transferEngineRef.current?.getReceivedManifest() || []
        })));
      }
    }
  };

  const cancelTransfer = () => {
    console.log("CONSOLE: Cancelling transfer");
    
    // Stop engine and clean up memory
    if (transferEngineRef.current) {
      transferEngineRef.current.cancel();
      transferEngineRef.current = null;
    }
    
    // Notify peer
    if (controlConnRef.current.length > 0 && connectedRef.current) {
      controlConnRef.current.forEach(c => c.send(JSON.stringify({ type: "CANCEL_TRANSFER" })));
    }

    // Reset local state
    setIncomingFile(null);
    incomingFileRef.current = null;
    fileChunksRef.current = [];
    setTransferProgress(0);
    transferRequestedRef.current = false;
    isTransferringFastRef.current = false;
    isTransferringRef.current = false;
    setIsTransferring(false);
    setIsGrabbedPermanent(false);
    isGrabbedPermanentRef.current = false;
    setSelectedFiles([]);
    selectedFilesRef.current = [];
    setCurrentFileIndex(0);
    currentFileIndexRef.current = 0;
    setTelemetry(null);
    
    // Reset file input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    
    setMessages((prev) => [...prev, `SYSTEM: Transfer cancelled.`]);

    // Unlock room
    if (socketRef.current) {
      socketRef.current.emit("dropped", roomCodeRef.current);
    }
  };

  const handleEngineComplete = (blob: Blob | null) => {
    if (isSourceRef.current) return;

    const fileName = incomingFileRef.current?.name || "downloaded_file";
    console.log(`CONSOLE: Finalizing file "${fileName}" (${blob ? 'buffered' : 'streamed to disk'})`);
    
    // Add to received files list (streaming mode has no re-downloadable blob)
    if (blob) {
      const newFile = {
        name: fileName,
        blob: blob,
        id: Math.random().toString(36).substring(7)
      };
      setReceivedFiles(prev => [newFile, ...prev]);
    }

    // ── Reset state ────────────────────────────────────────────────────
    setIncomingFile(null);
    incomingFileRef.current = null;
    fileChunksRef.current = [];
    setTransferProgress(0);
    isTransferringRef.current = false;
    isTransferringFastRef.current = false;
    setIsTransferring(false);
    setTelemetry(null);
    if (transferEngineRef.current) {
      transferEngineRef.current.cleanup();
      transferEngineRef.current = null;
    }

    // ── CRITICAL: Send TRANSFER_COMPLETE synchronously before any async file I/O ─
    // Sender is blocked waiting for this. Any await before this = deadlock.
    if (controlConnRef.current.length > 0 && connectedRef.current) {
      console.log("CONSOLE: Sending TRANSFER_COMPLETE to peer");
      controlConnRef.current.forEach(c => c.send(JSON.stringify({ type: "TRANSFER_COMPLETE" })));
    }
    
    // ── Save / notify async AFTER unblocking sender ───────────────────────
    if (blob) {
      // Buffered mode: blob in RAM — save to disk async
      saveFileAsync(blob, fileName);
    } else {
      // Streaming mode: file already written to disk by the engine
      setMessages(prev => [...prev, `SYSTEM: ✓ Saved to folder: ${fileName}`]);
    }
  };

  // Saves a file using the File System Access API (one directory prompt per session)
  // or falls back to the <a download> method. Runs after the sender is already unblocked.
  const saveFileAsync = async (blob: Blob, fileName: string) => {
    const fsaAvailable = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    let savedSilently = false;

    if (fsaAvailable) {
      try {
        if (!hasSaveDirectoryRef.current) {
          const dirHandle = await (window as any).showDirectoryPicker({
            mode: 'readwrite',
            startIn: 'downloads',
          });
          saveDirectoryHandleRef.current = dirHandle;
          hasSaveDirectoryRef.current = true;
        }
        if (saveDirectoryHandleRef.current) {
          const fileHandle = await saveDirectoryHandleRef.current.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          savedSilently = true;
          setMessages(prev => [...prev, `SYSTEM: Saved to folder: ${fileName}`]);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.warn('File System Access API write failed, falling back:', err);
        } else {
          hasSaveDirectoryRef.current = false;
          saveDirectoryHandleRef.current = null;
        }
      }
    }

    if (!savedSilently) {
      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setMessages(prev => [...prev, `SYSTEM: Received & Saved: ${fileName}`]);
      } catch (e) {
        console.error('Auto-download failed:', e);
      }
    }
  };

  useEffect(() => {
    if (isSocketConnected && joinedRef.current && roomCodeRef.current && socketRef.current) {
      console.log("Socket reconnected, warm up MediaPipe again");
      warmUpMediaPipe();
    }
  }, [isSocketConnected, warmUpMediaPipe]);

  const resetWebRTCConnection = useCallback(() => {
    console.log("Resetting WebRTC Connection...");
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (transferEngineRef.current) {
      transferEngineRef.current.destroy();
      transferEngineRef.current = null;
    }
    connRef.current = [];
    controlConnRef.current = [];
    setConnected(false);
    isTransferringFastRef.current = false;
    isTransferringRef.current = false;
    setIsTransferring(false);
    
    // Re-emit join-room to restart the matching process
    if (socketRef.current && roomCodeRef.current.length === 4) {
      setTimeout(() => {
         socketRef.current?.emit("join-room", roomCodeRef.current);
      }, 100);
    }
  }, []);

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) {
       pcRef.current.close();
    }
    const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ]
    });
    
    // 3-second ICE gathering timeout to force trickle if stuck
    let iceTimeout: any;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Trickle ICE
        socketRef.current?.emit("ice-candidate", { roomId: roomCodeRef.current, candidate: event.candidate });
      } else {
        console.log("ICE gathering complete natively.");
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE Connection State:", pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
         setConnected(true);
      } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
         setConnected(false);
      }
    };

    pcRef.current = pc;
    return pc;
  }, []);

  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
     dc.binaryType = 'arraybuffer';

     dc.onopen = () => {
        console.log(`DataChannel ${dc.label} is open`);
        const allDataOpen = connRef.current.length === 3 && connRef.current.every(c => c.readyState === 'open');
        const ctrlOpen = controlConnRef.current[0]?.readyState === 'open';
        
        if (allDataOpen && ctrlOpen) {
           console.log("All channels open! Initializing TransferEngine...");
           setConnected(true);
           setupEngineConnections(connRef.current, controlConnRef.current);
        }
     };

     dc.onclose = () => {
        console.log(`DataChannel ${dc.label} closed`);
        if (dc.label === 'control') {
          controlConnRef.current = controlConnRef.current.filter(c => c !== dc);
        } else {
          connRef.current = connRef.current.filter(c => c !== dc);
        }
        if (connRef.current.length === 0 && controlConnRef.current.length === 0) {
          setConnected(false);
          transferEngineRef.current?.destroy();
          transferEngineRef.current = null;
        }
     };

     dc.onerror = (err) => {
        console.error(`DataChannel ${dc.label} error:`, err);
     };

     if (dc.label === 'control') {
        dc.onmessage = async (e) => {
           const data = e.data;
           const isBinary = data instanceof ArrayBuffer || 
                           (typeof Blob !== 'undefined' && data instanceof Blob) ||
                           (data && (data as any).buffer instanceof ArrayBuffer);
           if (isBinary) {
             let buffer: ArrayBuffer;
             if (data instanceof ArrayBuffer) {
               buffer = data;
             } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
               buffer = await data.arrayBuffer();
             } else {
               buffer = (data as any).buffer;
             }

             if (buffer.byteLength === 5) {
               const view = new DataView(buffer);
               const type = view.getUint8(0);
               const index = view.getUint32(1, true);
               if (type === 0x02) {
                 transferEngineRef.current?.processAck(index);
               } else if (type === 0x03) {
                 transferEngineRef.current?.processNack(index);
               }
             }
             return;
           }

           let payload = data;
           if (typeof data === 'string') {
             try { payload = JSON.parse(data); } catch (err) { payload = data; }
           }
           
           if (payload && typeof payload === 'object') {
             if (payload.type === "FILE_META") {
               console.log("CONSOLE: Received FILE_META:", payload.file);
               incomingFileRef.current = payload.file;
               setIncomingFile(payload.file);
               
               const newEngine = createTransferEngine(connRef.current);
               newEngine.initReceiver(payload.file);

               if (saveDirectoryHandleRef.current) {
                 try {
                   const fh = await saveDirectoryHandleRef.current.getFileHandle(
                     payload.file.name, { create: true }
                   );
                   const wr = await fh.createWritable();
                   if (payload.file.size > 0) {
                     await (wr as any).truncate(payload.file.size);
                   }
                   newEngine.setStreamWriter(wr);
                   console.log(`[Stream] Ready → streaming "${payload.file.name}" to disk`);
                 } catch (streamErr) {
                   console.warn('[Stream] Failed to open file for streaming:', streamErr);
                 }
               }
               
               if (transferRequestedRef.current && isGlobalLockedRef.current && !isSourceRef.current) {
                 console.log("CONSOLE: Auto-accepting next file in multi-file transfer");
                 isTransferringRef.current = true;
                 setIsTransferring(true);
                 controlConnRef.current.forEach(c => {
                   if (c.readyState === 'open') {
                     c.send(JSON.stringify({ type: "START_TRANSFER", resumeManifest: [] }));
                   }
                 });
                 setMessages((prev) => [...prev, `SYSTEM: Auto-downloading next file: ${payload.file.name}`]);
               } else {
                 transferRequestedRef.current = false;
                 setMessages((prev) => [...prev, `SYSTEM: Incoming file ready: ${payload.file.name}. Perform DROP gesture to download.`]);
               }
             } else if (payload.type === "START_TRANSFER") {
               console.log("CONSOLE: Received START_TRANSFER from peer. Executing transfer.");
               const fileToSend = selectedFilesRef.current[currentFileIndexRef.current];
               if (fileToSend) {
                 executeTransfer(fileToSend, payload.resumeManifest || []);
               }
             } else if (payload.type === "CANCEL_TRANSFER") {
               console.log("CONSOLE: Received CANCEL_TRANSFER from peer.");
               if (transferEngineRef.current) {
                 transferEngineRef.current.cancel();
               }
               setIncomingFile(null);
               incomingFileRef.current = null;
               fileChunksRef.current = [];
               setTransferProgress(0);
               transferRequestedRef.current = false;
               isTransferringRef.current = false;
               setIsTransferring(false);
               setSelectedFiles([]);
               selectedFilesRef.current = [];
               setCurrentFileIndex(0);
               currentFileIndexRef.current = 0;
               setTelemetry(null);
               if (fileInputRef.current) fileInputRef.current.value = '';
               setMessages((prev) => [...prev, `SYSTEM: Peer cancelled the transfer.`]);
             } else if (payload.type === "TRANSFER_COMPLETE") {
               console.log("CONSOLE: Received TRANSFER_COMPLETE from peer");
               isTransferringRef.current = false;
               isTransferringFastRef.current = false;
               setIsTransferring(false);
               setTelemetry(null);
               if (transferEngineRef.current) {
                 transferEngineRef.current.destroy();
                 transferEngineRef.current = null;
               }
               
               const nextIdx = currentFileIndexRef.current + 1;
               if (nextIdx < selectedFilesRef.current.length) {
                 setCurrentFileIndex(nextIdx);
                 currentFileIndexRef.current = nextIdx;
                 const nextFile = selectedFilesRef.current[nextIdx];
                 setMessages((prev) => [...prev, `SYSTEM: File sent successfully. Preparing next file: ${nextFile.name} (${nextIdx + 1}/${selectedFilesRef.current.length})`]);
                 
                 if (controlConnRef.current.length > 0 && connectedRef.current) {
                   controlConnRef.current.forEach(c => {
                     if (c.readyState === 'open') {
                       c.send(JSON.stringify({
                         type: "FILE_META",
                         file: {
                           name: nextFile.name,
                           type: nextFile.type,
                           size: nextFile.size,
                           totalChunks: Math.ceil(nextFile.size / CHUNK_SIZE),
                           chunkSize: CHUNK_SIZE
                         }
                       }));
                     }
                   });
                 }
               } else {
                 setMessages((prev) => [...prev, `SYSTEM: All ${selectedFilesRef.current.length} file(s) sent successfully!`]);
                 setSelectedFiles([]);
                 selectedFilesRef.current = [];
                 setCurrentFileIndex(0);
                 currentFileIndexRef.current = 0;
                 if (fileInputRef.current) fileInputRef.current.value = '';
                 
                 if (controlConnRef.current.length > 0 && connectedRef.current) {
                   controlConnRef.current.forEach(c => {
                     if (c.readyState === 'open') {
                       c.send(JSON.stringify({ type: "ALL_FILES_DONE" }));
                     }
                   });
                 }
                 
                 if (socketRef.current) {
                   console.log("CONSOLE: All files sent. Emitting 'dropped' to unlock room.");
                   socketRef.current.emit("dropped", roomCodeRef.current);
                 }
               }
             } else if (payload.type === "ALL_FILES_DONE") {
               console.log("CONSOLE: Received ALL_FILES_DONE from peer");
               setMessages((prev) => [...prev, `SYSTEM: All files have been received.`]);
               transferRequestedRef.current = false;
             } else if (payload.type === "PING") {
               dc.send(JSON.stringify({ type: "PONG" }));
             } else if (payload.type === "PONG") {
               setMessages(prev => [...prev, "SYSTEM: P2P Connection verified!"]);
             }
           } else {
             const message = String(data);
             setMessages((prev) => [...prev, `Peer: ${message}`]);
           }
        };
     } else {
        dc.onmessage = async (e) => {
           const data = e.data;
           const isBinary = data instanceof ArrayBuffer ||
             (typeof Blob !== 'undefined' && data instanceof Blob) ||
             (data && (data as any).buffer instanceof ArrayBuffer);

           if (isBinary) {
             let buffer: ArrayBuffer;
             if (data instanceof ArrayBuffer) {
               buffer = data;
             } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
               buffer = await data.arrayBuffer();
             } else {
               buffer = (data as any).buffer;
             }

             if (buffer.byteLength > HEADER_SIZE) {
               transferEngineRef.current?.enqueueChunk(buffer);
             }
           }
        };
     }
  }, []);

  const createTransferEngine = useCallback((conns: RTCDataChannel[]) => {
    if (transferEngineRef.current) {
      transferEngineRef.current.destroy();
      transferEngineRef.current = null;
    }
    const engine = new TransferEngine(conns);
    engine.setControlConnections(controlConnRef.current);
    transferEngineRef.current = engine;
    engine.setCallbacks(
      (t) => {
        setTelemetry(t);
        setTransferProgress(t.progress);
      },
      (blob) => {
        if (blob instanceof Blob) {
           handleEngineComplete(blob);
        } else if (blob === null) {
           handleEngineComplete(null);
        } else {
           console.log("CONSOLE: Sender finished transfer. Waiting for receiver to acknowledge.");
        }
      }
    );
    return engine;
  }, []);

  const setupEngineConnections = useCallback((dataConns: RTCDataChannel[], controlConns: RTCDataChannel[]) => {
    createTransferEngine(dataConns);
    
    for (const conn of dataConns) {
      if (conn.readyState === 'open') setConnected(true);
    }
    for (const conn of controlConns) {
      if (conn.readyState === 'open') setConnected(true);
    }

    const currentFile = selectedFilesRef.current[currentFileIndexRef.current];
    if (isSourceRef.current && currentFile) {
      console.log("CONSOLE: Resending FILE_META on re-setup");
      const metaPayload = JSON.stringify({
        type: "FILE_META",
        file: {
          name: currentFile.name,
          type: currentFile.type,
          size: currentFile.size,
          totalChunks: Math.ceil(currentFile.size / CHUNK_SIZE),
          chunkSize: CHUNK_SIZE
        }
      });
      controlConns.forEach(c => {
        if (c.readyState === 'open') {
          c.send(metaPayload);
        }
      });
    }
    
    if (!isSourceRef.current && isGlobalLockedRef.current && incomingFileRef.current) {
      const engine = transferEngineRef.current;
      if (engine) {
        const resumeManifest = engine.getReceivedManifest();
        console.log(`CONSOLE: Sending START_TRANSFER with ${resumeManifest.length} already-received chunks`);
        transferRequestedRef.current = true;
        isTransferringRef.current = true;
        setIsTransferring(true);
        controlConns.forEach(c => {
          if (c.readyState === 'open') {
            c.send(JSON.stringify({
              type: "START_TRANSFER",
              resumeManifest
            }));
          }
        });
      }
    }
  }, [createTransferEngine]);

  const setupOfferer = useCallback(async () => {
    const pc = createPeerConnection();
    
    // We expect 3 data channels (data0, data1, data2) + 1 control channel.
    const DATA_CHANNEL_COUNT = 3;
    const dataConnsRaw: RTCDataChannel[] = [];
    const controlConnsRaw: RTCDataChannel[] = [];

    for (let i=0; i<DATA_CHANNEL_COUNT; i++) {
        const dc = pc.createDataChannel(`data${i}`, { ordered: false });
        dataConnsRaw.push(dc);
        setupDataChannel(dc);
    }
    const controlDc = pc.createDataChannel('control', { ordered: true });
    controlConnsRaw.push(controlDc);
    setupDataChannel(controlDc);

    connRef.current = dataConnsRaw;
    controlConnRef.current = controlConnsRaw;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socketRef.current?.emit("offer", { roomId: roomCodeRef.current, sdp: offer });
  }, [createPeerConnection, setupDataChannel]);

  const setupAnswerer = useCallback(async () => {
    const pc = createPeerConnection();

    pc.ondatachannel = (event) => {
        const dc = event.channel;
        if (dc.label === 'control') {
           controlConnRef.current.push(dc);
        } else if (dc.label.startsWith('data')) {
           connRef.current.push(dc);
        }
        setupDataChannel(dc);
    };
  }, [createPeerConnection, setupDataChannel]);

  const handleJoin = () => {
    if (roomCode.length === 4 && socketRef.current) {
       console.log("Joining room:", roomCode);
       socketRef.current.emit("join-room", roomCode);
    }
  };

  const sendTest = () => {
    if (controlConnRef.current.length > 0 && connected && testMessage) {
      controlConnRef.current.forEach(c => c.send(testMessage));
      setMessages((prev) => [...prev, `You: ${testMessage}`]);
      setTestMessage("");
    }
  };

  const testP2P = () => {
    if (controlConnRef.current.length > 0 && connected) {
      console.log("CONSOLE: Sending PING to peer");
      controlConnRef.current.forEach(c => c.send(JSON.stringify({ type: "PING" })));
      setMessages(prev => [...prev, "SYSTEM: Testing P2P connection..."]);
    } else {
      setMessages(prev => [...prev, "ERROR: Not connected to any peer."]);
    }
  };

  const simulateGrab = () => {
    socketRef.current?.emit("grabbed", roomCodeRef.current);
  };

  const simulateDrop = () => {
    socketRef.current?.emit("dropped", roomCodeRef.current);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-white/10 p-6 flex justify-between items-center bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
            <Send className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Nexus <span className="text-blue-500">Spatial</span></h1>
        </div>
        <div className="flex items-center gap-4">
          <div className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-all",
            connected ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"
          )}>
            <div className={cn("w-2 h-2 rounded-full animate-pulse", connected ? "bg-green-400" : "bg-yellow-400")} />
            {connected ? "P2P Connected" : joined ? "Waiting for Peer..." : "Not Connected"}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-8 space-y-8">
        {!joined ? (
          <div className="max-w-md mx-auto mt-20 space-y-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="space-y-2">
              <h2 className="text-4xl font-bold tracking-tight">Connect Devices</h2>
              <p className="text-white/50">Enter a 4-digit code to pair your phone and laptop.</p>
            </div>
            
            <div className="bg-white/5 p-8 rounded-3xl border border-white/10 shadow-2xl space-y-6">
              <div className="flex justify-center gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="w-12 h-16 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center text-2xl font-mono">
                    {roomCode[i-1] || ""}
                  </div>
                ))}
              </div>
              
              <input
                type="text"
                maxLength={4}
                placeholder="Enter 4-digit code"
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-center text-xl font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.replace(/[^0-9]/g, ""))}
              />
              
              <button
                onClick={handleJoin}
                disabled={roomCode.length !== 4}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg shadow-blue-600/30 transition-all active:scale-[0.98]"
              >
                Join Room
              </button>
              
              <p className="text-white/30 text-[10px] uppercase tracking-widest font-bold pt-4">
                Note: Camera access is required for gesture recognition.
              </p>
            </div>

            <div className="flex justify-center gap-12 text-white/30 pt-8">
              <div className="flex flex-col items-center gap-2">
                <Smartphone className="w-8 h-8" />
                <span className="text-[10px] uppercase tracking-widest font-bold">Mobile</span>
              </div>
              <div className="w-px h-12 bg-white/10" />
              <div className="flex flex-col items-center gap-2">
                <Laptop className="w-8 h-8" />
                <span className="text-[10px] uppercase tracking-widest font-bold">Desktop</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in duration-700">
            {/* Camera / Gesture Preview */}
            <div className="space-y-4">
              <div className="relative aspect-video bg-white/5 rounded-3xl border border-white/10 overflow-hidden group">
                {cameraError ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-red-500/10 backdrop-blur-sm">
                    <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
                    <p className="text-sm font-medium text-red-400 mb-6">{cameraError}</p>
                    <button 
                      onClick={startCamera}
                      className="bg-white/10 hover:bg-white/20 px-6 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all"
                    >
                      Retry Camera
                    </button>
                  </div>
                ) : (
                  <>
                    <video 
                      ref={videoRef} 
                      className="hidden" 
                      playsInline 
                      muted 
                    />
                    <canvas 
                      ref={canvasRef} 
                      className="w-full h-full object-cover"
                      width={640}
                      height={360}
                    />
                  </>
                )}
                
                {/* Grab Overlay Effect */}
                <div className={cn(
                  "absolute inset-0 bg-blue-600/20 backdrop-blur-sm transition-opacity duration-500 flex items-center justify-center opacity-0 pointer-events-none",
                  isGrabbed && "opacity-100"
                )}>
                  <div className="w-32 h-32 border-4 border-blue-400 rounded-full animate-ping" />
                  <span className="absolute font-black text-4xl tracking-tighter uppercase italic text-blue-400">Grabbed!</span>
                </div>

                {/* Drop Overlay Effect */}
                <div className={cn(
                  "absolute inset-0 bg-emerald-600/20 backdrop-blur-sm transition-opacity duration-500 flex items-center justify-center opacity-0 pointer-events-none",
                  isDropped && "opacity-100"
                )}>
                  <div className="w-32 h-32 border-4 border-emerald-400 rounded-full animate-ping" />
                  <span className="absolute font-black text-4xl tracking-tighter uppercase italic text-emerald-400">Dropped!</span>
                </div>

                {/* Carrying Indicator */}
                {isGlobalLocked && !isSource && (
                  <div className="absolute top-6 right-6 bg-blue-600 px-4 py-2 rounded-full flex items-center gap-2 animate-bounce shadow-lg shadow-blue-600/40 border border-blue-400/50">
                    <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                    <span className="text-[10px] font-black uppercase tracking-widest">
                      {incomingFile ? `Target: Dropping ${incomingFile.name} (${transferProgress}%)` : "Target: Open Palm to Drop"}
                    </span>
                  </div>
                )}

                {isGlobalLocked && isSource && (
                  <div className="absolute top-6 left-6 bg-amber-600 px-4 py-2 rounded-full flex items-center gap-2 shadow-lg shadow-amber-600/40 border border-amber-400/50">
                    <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                    <span className="text-[10px] font-black uppercase tracking-widest">
                      {isTransferring ? `Source: Sending File (${transferProgress}%)` : "Source: Data Sent"}
                    </span>
                  </div>
                )}

                {telemetry && (isTransferring || incomingFile) && (
                  <div className="absolute bottom-6 left-6 right-6 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl p-4 text-xs font-mono text-white/80 shadow-2xl flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>Speed: <span className="text-emerald-400">{telemetry.speedMBps.toFixed(2)} MB/s</span></div>
                      <div>ETA: <span className="text-blue-400">{Math.round(telemetry.etaSeconds)}s</span></div>
                      <div>Chunks: <span className="text-amber-400">{telemetry.chunksSent} / {telemetry.totalChunks}</span></div>
                      <div>Retransmits: <span className="text-red-400">{telemetry.retransmits}</span></div>
                      <div>In-Flight: <span className="text-purple-400">{telemetry.inFlight}</span></div>
                      <div>Progress: <span className="text-white">{telemetry.progress}%</span></div>
                      <div>Window: <span className="text-cyan-400">{telemetry.windowSize} chunks</span></div>
                    </div>
                    {/* Progress Bar */}
                    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-emerald-500 transition-all duration-300 ease-out"
                        style={{ width: `${telemetry.progress}%` }}
                      />
                    </div>
                    
                    {/* Cancel Button */}
                    <button 
                      onClick={cancelTransfer}
                      className="mt-1 w-full py-2 bg-red-500/20 hover:bg-red-500/40 text-red-200 rounded-lg transition-colors font-bold tracking-wider text-xs uppercase border border-red-500/30"
                    >
                      Cancel Transfer
                    </button>
                  </div>
                )}
              </div>
              
              <div className="flex gap-4">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden"
                  multiple
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) {
                      setSelectedFiles(Array.from(files));
                      setCurrentFileIndex(0);
                      currentFileIndexRef.current = 0;
                    }
                  }}
                />
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "flex-1 bg-white/5 hover:bg-white/10 border border-white/10 py-4 rounded-2xl font-bold transition-all flex items-center justify-center gap-2",
                    selectedFiles.length > 0 && "border-blue-500/50 bg-blue-500/5"
                  )}
                >
                  <Upload className="w-4 h-4" />
                  {selectedFiles.length > 1 
                    ? `${selectedFiles.length} files selected` 
                    : selectedFiles.length === 1 
                      ? selectedFiles[0].name 
                      : "Select File(s)"}
                </button>
                <button 
                  onClick={() => {
                    if (selectedFiles.length > 0) {
                      // NOTE: Do NOT call simulateDrop() here — that emits 'dropped' to the socket
                      // and triggers global-unlock which wipes state before transfer starts.
                      // simulateGrab() is correct here: it locks the room.
                      simulateGrab();
                      handleGrabAction();
                    }
                  }}
                  disabled={selectedFiles.length === 0 || isGlobalLocked}
                  className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-30 border border-white/10 py-4 rounded-2xl font-bold transition-all active:scale-95"
                >
                  Simulate Grab
                </button>
                <button 
                  onClick={() => {
                    if (isGlobalLocked && !isSource) {
                      // Do NOT call simulateDrop() — that unlocks the room immediately.
                      // Only the sender unlocks after all files are transferred.
                      handleDropAction();
                    }
                  }}
                  disabled={!isGlobalLocked || isSource}
                  className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-30 border border-white/10 py-4 rounded-2xl font-bold transition-all active:scale-95"
                >
                  Simulate Drop
                </button>
              </div>

              {/* Received Files Section */}
              {receivedFiles.length > 0 && (
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-3xl p-6 space-y-4 animate-in fade-in slide-in-from-top-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-emerald-400 flex items-center gap-2">
                      <Download className="w-4 h-4" />
                      Received Files
                    </h3>
                    <span className="text-[10px] font-mono text-emerald-500/50">{receivedFiles.length} item(s)</span>
                  </div>
                  <div className="space-y-2">
                    {receivedFiles.map((file) => (
                      <div key={file.id} className="bg-white/5 border border-white/10 rounded-xl p-3 flex items-center justify-between group">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div className="w-8 h-8 bg-emerald-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
                            <FileIcon className="w-4 h-4 text-emerald-400" />
                          </div>
                          <span className="text-sm font-medium truncate text-white/80">{file.name}</span>
                        </div>
                        <button
                          onClick={() => {
                            const url = URL.createObjectURL(file.blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = file.name;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                          }}
                          className="bg-emerald-500 hover:bg-emerald-400 text-black p-2 rounded-lg transition-all opacity-0 group-hover:opacity-100 focus:opacity-100"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Test Console */}
            <div className="bg-white/5 rounded-3xl border border-white/10 flex flex-col h-[400px]">
              <div className="p-4 border-b border-white/10 flex justify-between items-center">
                <h3 className="text-xs font-bold uppercase tracking-widest text-white/50">P2P Console</h3>
                <div className="flex gap-4">
                  <button 
                    onClick={testP2P}
                    disabled={!connected}
                    className="text-[10px] uppercase tracking-widest font-bold text-blue-400 hover:text-blue-300 disabled:opacity-30 transition-colors"
                  >
                    Test Connection
                  </button>
                  <button 
                    onClick={() => setMessages([])}
                    className="text-[10px] uppercase tracking-widest font-bold text-white/30 hover:text-white/50 transition-colors"
                  >
                    Clear Logs
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-sm">
                {messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-white/10 italic">
                    No messages yet...
                  </div>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={cn(
                      "p-2 rounded-lg",
                      m.startsWith("You:") ? "bg-blue-500/10 text-blue-300 ml-4" : "bg-white/5 text-white/70 mr-4"
                    )}>
                      {m}
                    </div>
                  ))
                )}
              </div>

              <div className="p-4 border-t border-white/10 flex gap-2">
                <input
                  type="text"
                  placeholder="Type test message..."
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendTest()}
                />
                <button
                  onClick={sendTest}
                  disabled={!connected}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 p-2 rounded-xl transition-all"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer Status */}
      <footer className="fixed bottom-0 left-0 right-0 p-4 flex justify-center pointer-events-none">
        <div className="bg-black/80 backdrop-blur-xl border border-white/10 px-6 py-2 rounded-full flex items-center gap-6 shadow-2xl">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold">
            <div className={cn("w-1.5 h-1.5 rounded-full", isSocketConnected ? "bg-green-500" : "bg-red-500")} />
            <span className={isSocketConnected ? "text-white/70" : "text-red-400"}>Signaling Server</span>
          </div>
          <div className="w-px h-4 bg-white/10" />
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold">
            <div className={cn("w-1.5 h-1.5 rounded-full", connected ? "bg-green-500" : "bg-white/20")} />
            <span className={connected ? "text-white/70" : "text-white/30"}>WebRTC P2P</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
