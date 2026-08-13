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
  // Stalled-flag writer is U5; until then it stays false and `stalled` is
  // unreachable. The phase bridge reads this alongside isTransferring and the
  // transfer-requested ref, so a real stall can flip the published phase.
  const [isTransferStalled, setIsTransferStalled] = useState(false);
  const [telemetry, setTelemetry] = useState<TransferTelemetry | null>(null);
  const transferEngineRef = useRef<TransferEngine | null>(null);
  const [incomingFile, setIncomingFile] = useState<{ name: string, type: string, size: number } | null>(null);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  // opfsHandle: FileSystemFileHandle kept alive until user saves — do NOT delete OPFS at completion,
  // only after a successful download. Deleting it early invalidates the File object → "Check internet connection".
  const [receivedFiles, setReceivedFiles] = useState<{ name: string, blob: Blob | null, opfsHandle: any | null, id: string }[]>([]);
  const saveDirectoryHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const hasSaveDirectoryRef = useRef(false);
  const isChoosingDirectoryRef = useRef(false);
  const directoryPickerDeclinedRef = useRef(false);
  const opfsFileHandleRef = useRef<any>(null);
  // Tracks the FileSystemFileHandle for the current FSA stream (showSaveFilePicker path)
  // so we can delete the partial file if the transfer is cancelled mid-way.
  const streamFileHandleRef = useRef<any>(null);

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
  const pendingDropActionRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);
  // Watchdog: if ICE stays in 'checking' for 10s without connecting, force a rejoin
  const iceWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStartTransferRef = useRef<{ file: File, resumeManifest: number[] } | null>(null);
  // U2 (KTD3): per-transfer id minted by the sender when it builds FILE_META and
  // echoed in every resume message, so a resume can never re-seed the wrong
  // transfer after a cancel-and-restart. Never persisted.
  const transferIdRef = useRef<string | null>(null);
  const incomingTransferIdRef = useRef<string | null>(null);
  // U2/U3: receiver-published progress waiting for the sender to re-arm against it.
  const resumeManifestRef = useRef<number[]>([]);
  // isGestureDropRef removed — handleDropAction no longer distinguishes gesture vs button

  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) {
    let id = typeof window !== 'undefined' ? sessionStorage.getItem('nexus_client_id') : null;
    if (!id) {
      id = 'client_' + Math.random().toString(36).substring(2, 15);
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('nexus_client_id', id);
      }
    }
    clientIdRef.current = id;
  }

  const startBackgroundAudio = useCallback(async () => {
    if (backgroundAudioRef.current) {
      try {
        await backgroundAudioRef.current.play();
        console.log("[BackgroundMode] Silent audio playing, connection will stay alive in background.");
        if ('mediaSession' in navigator) {
          (navigator as any).mediaSession.metadata = new MediaMetadata({
            title: 'Nexus Spatial Share',
            artist: 'Background Connection Active',
          });
        }
      } catch (e) {
        console.warn("[BackgroundMode] Could not play silent audio:", e);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof Audio !== 'undefined') {
      const a = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
      a.loop = true;
      backgroundAudioRef.current = a;
    }
    (window as any).startBackgroundAudio = startBackgroundAudio;
    return () => {
      delete (window as any).startBackgroundAudio;
    };
  }, [startBackgroundAudio]);

  useEffect(() => { roomCodeRef.current = roomCode; }, [roomCode]);
  useEffect(() => { joinedRef.current = joined; }, [joined]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { isGlobalLockedRef.current = isGlobalLocked; }, [isGlobalLocked]);
  useEffect(() => { isSourceRef.current = isSource; }, [isSource]);
  useEffect(() => { selectedFilesRef.current = selectedFiles; }, [selectedFiles]);
  useEffect(() => { currentFileIndexRef.current = currentFileIndex; }, [currentFileIndex]);

  // BUG 15 FIX: WakeLock to prevent mobile screen sleep during transfer
  useEffect(() => {
    let wakeLock: any = null;
    let isMounted = true;

    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && isTransferring) {
        try {
          const wl = await (navigator as any).wakeLock.request('screen');
          if (isMounted && isTransferring) {
            wakeLock = wl;
            console.log('[WakeLock] Screen wake lock acquired');
          } else {
            wl.release();
          }
        } catch (err) {
          console.warn('[WakeLock] Failed to acquire screen wake lock:', err);
        }
      }
    };

    if (isTransferring) {
      requestWakeLock();
    }

    return () => {
      isMounted = false;
      if (wakeLock) {
        wakeLock.release().catch(console.error);
        console.log('[WakeLock] Screen wake lock released');
      }
    };
  }, [isTransferring]);

  const mediaPipeWarmedUp = useRef(false);
  const warmUpMediaPipe = useCallback(async () => {
    if (mediaPipeWarmedUp.current || !handsRef.current) return;
    try {
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

  const lastHiddenTimeRef = useRef<number>(0);

  // Mobile resilience: visibility change handling to recover from backgrounding
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenTimeRef.current = Date.now();
        console.log('[Visibility] App went to background');
      } else if (document.visibilityState === 'visible') {
        const bgDuration = lastHiddenTimeRef.current > 0 ? Date.now() - lastHiddenTimeRef.current : 0;
        console.log(`[Visibility] App returned from background after ${Math.round(bgDuration / 1000)}s`);
        lastHiddenTimeRef.current = 0;

        if (socketRef.current && !socketRef.current.connected) {
          console.log('[Visibility] Socket disconnected while in background — reconnecting...');
          socketRef.current.connect();
        } else if (socketRef.current && socketRef.current.connected && roomCodeRef.current.length === 4) {
          socketRef.current.emit("join-room", { roomCode: roomCodeRef.current, clientId: clientIdRef.current });
        }

        warmUpMediaPipe();

        if (isTransferringRef.current) {
          (window as any).Toast?.show?.('Resuming file transfer from pause point...', 'info');
          const openCtrl = controlConnRef.current.filter(c => c.readyState === 'open');
          if (openCtrl.length > 0) {
            if (!isSourceRef.current && isGlobalLockedRef.current && incomingFileRef.current && transferRequestedRef.current && transferEngineRef.current) {
              const resumeManifest = transferEngineRef.current.getReceivedManifest();
              console.log(`[Visibility] Auto-sending START_TRANSFER with ${resumeManifest.length} existing chunks`);
              openCtrl.forEach(c => c.send(JSON.stringify({ type: "START_TRANSFER", resumeManifest })));
            } else if (isSourceRef.current && transferIdRef.current) {
              // U4 (R1/R2): this peer is the sender returning to the foreground.
              // The receiver is the authority on progress, so probe it for its
              // manifest; the RESUME_MANIFEST reply re-arms the engine (U3).
              const req = JSON.stringify({ type: "RESUME_REQUEST", transferId: transferIdRef.current });
              console.log(`[Visibility] Auto-sending RESUME_REQUEST for ${transferIdRef.current}`);
              openCtrl.forEach(c => c.send(req));
            }
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [warmUpMediaPipe]);

  // Mobile warning toast when transfer starts
  useEffect(() => {
    if (isTransferring) {
      const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && window.innerWidth < 768;
      if (isMobile) {
        (window as any).Toast?.show?.('Keep app in foreground during transfer for best results.', 'info');
      }
    }
  }, [isTransferring]);

  useEffect(() => {
    const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? `${window.location.protocol}//${window.location.hostname}:3000`
      : `${window.location.protocol}//${window.location.host}`;
    const socket = io(SERVER_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 30000,
    });
    socketRef.current = socket;

    const hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    hands.onResults((results) => { onResults(results); });
    handsRef.current = hands;

    warmUpMediaPipe();

    socket.on("connect", () => {
      console.log("Connected to signaling server");
      setIsSocketConnected(true);
      (window as any).Signaling?.onConnect?.();
      if (roomCodeRef.current.length === 4) {
        socket.emit("join-room", { roomCode: roomCodeRef.current, clientId: clientIdRef.current });
      }
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from signaling server");
      setIsSocketConnected(false);
      (window as any).Signaling?.onDisconnect?.();
    });

    socket.on("connect_error", (err) => {
      console.log("Signaling connect error:", err);
      (window as any).showSignalingError?.();
    });

    socket.on("peer-disconnected", () => {
      console.log("Peer disconnected");
      (window as any).Signaling?.onPeerLeft?.(isTransferringRef.current);
    });

    socket.on("room-status", async ({ status, role, code }) => {
      console.log(`[Signaling] Room status: ${status}, role: ${role}`);
      const codeStr = typeof code === 'object' ? '' : String(code || '');
      const finalCode = codeStr || roomCodeRef.current;
      if (status === 'waiting') {
        setJoined(true);
        if ((window as any).transitionToSender) {
           (window as any).transitionToSender(finalCode);
        }
      } else if (status === 'ready') {
        setJoined(true);
        // Both clients transition to the shared workspace (transitionToSender)
        if ((window as any).transitionToSender) {
           (window as any).transitionToSender(finalCode);
        }
        if (connectedRef.current) {
          console.log("[Signaling] Already P2P connected, skipping WebRTC setup on room status update.");
          return;
        }
        if (role === 'offerer') {
          if ((window as any).Signaling?.onPeerJoined) {
            (window as any).Signaling.onPeerJoined('receiver');
          }
          await setupOfferer();
        } else {
          if ((window as any).Signaling?.onPeerJoined) {
            (window as any).Signaling.onPeerJoined('sender');
          }
          await setupAnswerer();
        }
      } else if (status === 'full') {
        setMessages(prev => [...prev, "SYSTEM: Room is full!"]);
        if (typeof (window as any).showRoomError === 'function') {
          (window as any).showRoomError('Room is full.');
        }
      }
    });

    socket.on("offer", async ({ sdp }) => {
      console.log("[Signaling] Received offer");
      // If our PC was destroyed (e.g. ICE failure restart race), recreate it as answerer
      // before processing the offer so it's never silently dropped.
      if (!pcRef.current || pcRef.current.signalingState === 'closed') {
        console.warn("[Signaling] No active PC for incoming offer — auto-creating answerer PC");
        await setupAnswerer();
      }
      if (pcRef.current && pcRef.current.signalingState !== 'closed') {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));

        const pending = pendingCandidatesRef.current;
        pendingCandidatesRef.current = [];
        for (const c of pending) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(c));
          } catch (e) {
            console.error("Error adding queued ice candidate (offer)", e);
          }
        }

        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit("answer", { roomId: roomCodeRef.current, sdp: answer });
      }
    });

    socket.on("answer", async ({ sdp }) => {
      console.log("[Signaling] Received answer");
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        
        const pending = pendingCandidatesRef.current;
        pendingCandidatesRef.current = [];
        for (const c of pending) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(c));
          } catch (e) {
            console.error("Error adding queued ice candidate (answer)", e);
          }
        }
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      if (candidate) {
        if (pcRef.current && pcRef.current.remoteDescription) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error("Error adding received ice candidate", e);
          }
        } else {
          console.log("[Signaling] remoteDescription not ready, queuing ICE candidate");
          pendingCandidatesRef.current.push(candidate);
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
      isGlobalLockedRef.current = true;
      const isMe = socket.id === sourceId;
      setIsSource(isMe);
      isSourceRef.current = isMe;
      if (isMe) {
        setIsGrabbed(true);
        setIsGrabbedPermanent(true);
        setTimeout(() => setIsGrabbed(false), 2000);
        // Guaranteed FILE_META delivery: resend over WebRTC now that global-lock is confirmed.
        // This ensures the receiver gets it even if the initial WebRTC send raced the socket event.
        const currentFile = selectedFilesRef.current[currentFileIndexRef.current];
        if (currentFile) {
          const openCtrl = controlConnRef.current.filter(c => c.readyState === 'open');
          if (openCtrl.length > 0) {
            const meta = JSON.stringify({
              type: 'FILE_META',
              // U2: reuse the transferId minted for this file (KTD2). Omitting it
              // here corrupted the receiver's incomingTransferIdRef to null,
              // making the RESUME_REQUEST below be ignored as "unknown".
              transferId: transferIdRef.current ?? mintTransferId(),
              file: {
                name: currentFile.name,
                type: currentFile.type,
                size: currentFile.size,
                totalChunks: Math.ceil(currentFile.size / CHUNK_SIZE),
                chunkSize: CHUNK_SIZE,
                batchIndex: currentFileIndexRef.current,
                batchCount: selectedFilesRef.current.length
              }
            });
            openCtrl.forEach(c => c.send(meta));
            console.log('[global-lock] Resent FILE_META as guaranteed delivery');
          }
        }
      } else {
        // We are the receiver! Transition to receiver interface.
        if ((window as any).transitionToReceiver) {
          (window as any).transitionToReceiver(roomCodeRef.current);
        }
      }
    });

    socket.on("global-unlock", () => {
      console.log("CONSOLE: Received global-unlock from server. Room is now free.");
      setIsGlobalLocked(false);
      setIsSource(false);
      setIsGrabbedPermanent(false);
      
      if (!isTransferringRef.current) {
        setIncomingFile(null);
        incomingFileRef.current = null;
        fileChunksRef.current = [];
        setTransferProgress(0);
      }

      setIsDropped(true);
      setTimeout(() => setIsDropped(false), 2000);
      isGrabbedPermanentRef.current = false;
      // BUG 9 FIX: Reset transferRequestedRef on unlock so retry drop gestures work
      transferRequestedRef.current = false;
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      // Transition back to shared workspace if not on a success screen
      const isSuccessVisible = document.getElementById('success-screen')?.classList.contains('visible') || 
                               document.getElementById('receive-success')?.classList.contains('visible');
      if (!isSuccessVisible) {
        if ((window as any).transitionToSender) {
          (window as any).transitionToSender(roomCodeRef.current);
        }
        if ((window as any).resetSenderUI) {
          (window as any).resetSenderUI();
        }
        if ((window as any)._ch8CleanUp) {
          (window as any)._ch8CleanUp();
        }
      }
    });



    return () => {
      socket.disconnect();
      if (pcRef.current) { pcRef.current.close(); }
      if (handsRef.current) { handsRef.current.close(); }
      if (transferEngineRef.current) {
        transferEngineRef.current.cleanup();
        transferEngineRef.current = null;
      }
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
              if (videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
                isProcessing = true;
                try {
                  await handsRef.current.send({ image: videoRef.current });
                } catch (err: any) {
                  console.error("MediaPipe send error:", err);
                  if (err.message?.includes("abort") || err.message?.includes("memory")) {
                    setIsMediaPipeDead(true);
                    setCameraError("Gesture recognition engine crashed. Please refresh the page.");
                    return;
                  }
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
    if (requestRef.current) {
      cancelAnimationFrame(requestRef.current);
      requestRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
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
    const shouldBeOn = joined && !isTransferring && !isGrabbedPermanent &&
      (selectedFiles.length > 0 || (isGlobalLocked && !isSource));
    if (shouldBeOn) {
      startCamera();
    } else if (isCameraActive) {
      stopCamera();
    }
  }, [joined, selectedFiles, isGlobalLocked, isSource, startCamera, stopCamera, isCameraActive, isTransferring, isGrabbedPermanent]);

  // Connection health-check: if we joined but P2P never connected, periodically rejoin.
  // This handles the race where the ICE restart loop stalls (e.g. offer/answer race on LAN).
  useEffect(() => {
    if (!joined) return;
    const joinedAt = Date.now();
    const INITIAL_WAIT_MS = 8000;  // Wait 8s before first attempt
    const RETRY_INTERVAL_MS = 6000; // Check every 6s
    const MAX_ATTEMPTS = 4;
    let attempts = 0;

    const interval = setInterval(() => {
      if (connectedRef.current || isTransferringRef.current) return; // Already good
      if (Date.now() - joinedAt < INITIAL_WAIT_MS) return; // Too early
      if (attempts >= MAX_ATTEMPTS) { clearInterval(interval); return; } // Give up
      if (!socketRef.current?.connected || roomCodeRef.current.length !== 4) return;

      attempts++;
      console.warn(`[HealthCheck] Joined but not P2P connected — auto-rejoin attempt ${attempts}/${MAX_ATTEMPTS}`);
      socketRef.current.emit('join-room', { roomCode: roomCodeRef.current, clientId: clientIdRef.current });
    }, RETRY_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [joined]);

  const onResults = (results: Results) => {
    if (!canvasRef.current || !videoRef.current || !joinedRef.current) return;
    const canvasCtx = canvasRef.current.getContext("2d");
    if (!canvasCtx) return;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasRef.current.width, canvasRef.current.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      for (const landmarks of results.multiHandLandmarks) {
        const wrist = landmarks[0];

        const isFist = [8, 12, 16, 20].every(tipIdx => {
          const mcpIdx = tipIdx - 3;
          const tipDist = Math.sqrt(Math.pow(landmarks[tipIdx].x - wrist.x, 2) + Math.pow(landmarks[tipIdx].y - wrist.y, 2));
          const mcpDist = Math.sqrt(Math.pow(landmarks[mcpIdx].x - wrist.x, 2) + Math.pow(landmarks[mcpIdx].y - wrist.y, 2));
          return tipDist < mcpDist * 1.2;
        });

        const extendedFingers = [8, 12, 16, 20].filter(tipIdx => {
          const mcpIdx = tipIdx - 3;
          const tipDist = Math.sqrt(Math.pow(landmarks[tipIdx].x - wrist.x, 2) + Math.pow(landmarks[tipIdx].y - wrist.y, 2));
          const mcpDist = Math.sqrt(Math.pow(landmarks[mcpIdx].x - wrist.x, 2) + Math.pow(landmarks[mcpIdx].y - wrist.y, 2));
          return tipDist > mcpDist * 1.4;
        }).length;

        const isPalm = extendedFingers >= 3;

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

        let color = "#00FF00";
        if (isFist) color = "#3b82f6";
        if (isPalm && isGlobalLockedRef.current && !isSourceRef.current) color = "#10b981";
        if (isPalm && isSourceRef.current && isGlobalLockedRef.current) color = "#f59e0b";

        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color, lineWidth: 5 });
        drawLandmarks(canvasCtx, landmarks, { color: isFist ? "#ffffff" : "#FF0000", lineWidth: 2 });

        if (!isGlobalLockedRef.current) {
          if (isFist && lastGestureRef.current !== "fist" && selectedFilesRef.current.length > 0) {
            console.log("GESTURE: GRAB DETECTED - Files:", selectedFilesRef.current.length);
            lastGestureRef.current = "fist";
            document.getElementById('btn-grab')?.click();
          } else if (!isFist) {
            lastGestureRef.current = "none";
          }
        } else {
          if (!isSourceRef.current) {
            if (isPalm && lastGestureRef.current !== "palm") {
              console.log("GESTURE: DROP DETECTED - Triggering drop action");
              lastGestureRef.current = "palm";
              handleDropAction();
            } else if (!isPalm) {
              if (lastGestureRef.current === "palm") {
                lastGestureRef.current = "none";
              }
            }
          }
        }
      }
    }
    canvasCtx.restore();
  };

  const getCurrentFile = useCallback((): File | null => {
    const files = selectedFilesRef.current;
    const idx = currentFileIndexRef.current;
    if (files.length === 0 || idx >= files.length) return null;
    return files[idx];
  }, []);

  const mintTransferId = () => {
    const id = `tid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    transferIdRef.current = id;
    return id;
  };

  const handleGrabAction = async () => {
    const fileToSend = getCurrentFile();
    if (!fileToSend) {
      console.log("CONSOLE: handleGrabAction aborted - no file selected");
      setMessages(prev => [...prev, "ERROR: No file selected. Please select a file first."]);
      return;
    }

    // Populate file-overlay details for sender
    const overlay = document.getElementById('file-overlay');
    const nameEl = document.getElementById('overlay-name');
    const sizeEl = document.getElementById('overlay-size');
    if (overlay && nameEl && sizeEl) {
      nameEl.textContent = fileToSend.name;
      sizeEl.textContent = formatBytes(fileToSend.size);
      overlay.classList.add('active');
    }

    try {
      const totalFiles = selectedFilesRef.current.length;
      const fileNum = currentFileIndexRef.current + 1;
      console.log(`CONSOLE: Grabbed file "${fileToSend.name}" (${fileNum}/${totalFiles})`);

      isTransferringRef.current = false;
      transferRequestedRef.current = false;

      // BUG 7 + 11 FIX: Use readyState directly — never rely on connectedRef.current
      const openCtrl = controlConnRef.current.filter(c => c.readyState === 'open');
      const openData = connRef.current.filter(c => c.readyState === 'open');
      console.log(`CONSOLE: handleGrabAction — control channels: ${controlConnRef.current.length} total, ${openCtrl.length} open | data channels: ${connRef.current.length} total, ${openData.length} open`);

      if (openCtrl.length > 0) {
        const transferId = mintTransferId();
        const fileMeta = {
          name: fileToSend.name,
          type: fileToSend.type,
          size: fileToSend.size,
          totalChunks: Math.ceil(fileToSend.size / CHUNK_SIZE),
          chunkSize: CHUNK_SIZE,
          batchIndex: currentFileIndexRef.current,
          batchCount: selectedFilesRef.current.length
        };
        openCtrl.forEach(c => c.send(JSON.stringify({ type: "FILE_META", transferId, file: fileMeta })));
        setMessages((prev) => [...prev, `SYSTEM: Grabbed "${fileToSend.name}" (${fileNum}/${totalFiles}). FILE_META sent. Waiting for receiver to drop...`]);
        console.log(`CONSOLE: FILE_META sent for "${fileToSend.name}"`);
      } else {
        // Channels not open yet — still emit the grab so the room locks,
        // FILE_META will be resent automatically when channels open (see setupDataChannel handleOpen)
        console.warn("CONSOLE: handleGrabAction — no open control channels yet. FILE_META will be sent when WebRTC connects.");
        setMessages((prev) => [...prev, `SYSTEM: Grabbed "${fileToSend.name}" (${fileNum}/${totalFiles}). Waiting for P2P connection to send file info...`]);
      }
    } catch (err) {
      console.error("Grab action failed:", err);
      setSelectedFiles([]);
      simulateDrop();
    }
  };

  const executeTransfer = async (fileOverride?: File, resumeManifest: number[] = []) => {
    const file = fileOverride || getCurrentFile();
    if (!file) {
      console.error("CONSOLE: Cannot send file: No file available");
      setMessages(prev => [...prev, "ERROR: Cannot send file: No file available to send."]);
      return;
    }

    const openDataChans = connRef.current.filter(c => c.readyState === 'open');
    if (openDataChans.length === 0) {
      console.error("CONSOLE: Cannot send file: No open data channels");
      setMessages(prev => [...prev, `ERROR: Cannot send file: No open data channels (Total: ${connRef.current.length}).`]);
      return;
    }

    if (isTransferringRef.current) {
      console.log("CONSOLE: Transfer already in progress. Ignoring duplicate request.");
      setMessages(prev => [...prev, "WARNING: Transfer already in progress. Ignoring duplicate request."]);
      return;
    }

    isTransferringFastRef.current = true;
    console.log(`CONSOLE: Starting transfer of ${file.name} (${file.size} bytes)`);
    setMessages(prev => [...prev, `SYSTEM: Starting transfer of ${file.name} over ${openDataChans.length} data channels.`]);
    isTransferringRef.current = true;
    setIsTransferring(true);

    let engine = transferEngineRef.current;
    if (!engine) {
      engine = new TransferEngine(connRef.current);
      engine.setControlConnections(controlConnRef.current);
      transferEngineRef.current = engine;
      engine.setCallbacks(
        (t) => { setTelemetry(t); setTransferProgress(t.progress); },
        (blob) => {
          if (blob instanceof Blob) handleEngineComplete(blob);
          else if (blob === null) handleEngineComplete(null);
          else console.log("CONSOLE: Sender finished. Waiting for TRANSFER_COMPLETE.");
        }
      );
    } else {
      engine.setConnections(connRef.current, controlConnRef.current);
    }
    engine.startTransfer(file, resumeManifest);
  };

  const handleDropAction = async () => {
    if (!isSourceRef.current) {
      // Detailed state logging for debugging
      const openCtrl = controlConnRef.current.filter(c => c.readyState === 'open');
      const openData = connRef.current.filter(c => c.readyState === 'open');
      console.log(`CONSOLE: handleDropAction — incomingFile: ${JSON.stringify(incomingFileRef.current)} | control: ${openCtrl.length}/${controlConnRef.current.length} open | data: ${openData.length}/${connRef.current.length} open | transferRequested: ${transferRequestedRef.current}`);

      // If FILE_META hasn't arrived yet, request it explicitly from sender over P2P control channel
      if (!incomingFileRef.current) {
        if (openCtrl.length > 0) {
          console.log("CONSOLE: Drop clicked but FILE_META missing — sending REQUEST_FILE_META to sender");
          pendingDropActionRef.current = true;
          openCtrl.forEach(c => c.send(JSON.stringify({ type: "REQUEST_FILE_META" })));
          setMessages(prev => [...prev, "SYSTEM: Requesting file info from sender..."]);
        } else {
          setMessages(prev => [...prev, "ERROR: Drop failed — P2P connection not ready yet. Please wait a moment."]);
        }
        return;
      }

      if (transferRequestedRef.current) {
        console.log("CONSOLE: Transfer already requested. Ignoring duplicate drop.");
        setMessages(prev => [...prev, "SYSTEM: Transfer already in progress."]);
        return;
      }

      if (openCtrl.length === 0) {
        console.error("CONSOLE: handleDropAction — no open control channels.");
        setMessages(prev => [...prev, `ERROR: Cannot drop — P2P not connected (control: ${openCtrl.length}/${controlConnRef.current.length}, data: ${openData.length}/${connRef.current.length}). Wait for 'P2P Connected' status.`]);
        return;
      }

      // File saving is handled by saveFileAsync() after transfer completes.
      // No file picker dialogs here — saveFileAsync shows directory picker ONCE
      // for the first received file, then saves all subsequent files silently.

      console.log("CONSOLE: Drop recognized on receiver. Requesting transfer.");
      transferRequestedRef.current = true;
      isTransferringRef.current = true;
      setIsTransferring(true);
      setMessages(prev => [...prev, `SYSTEM: Drop recognized for "${incomingFileRef.current!.name}". Sending download request...`]);

      console.log("CONSOLE: Sending START_TRANSFER to peer");
      openCtrl.forEach(c => c.send(JSON.stringify({
        type: "START_TRANSFER",
        resumeManifest: transferEngineRef.current?.getReceivedManifest() || []
      })));
    } else {
      setMessages(prev => [...prev, "ERROR: You are the file source. Drop must be performed on the receiving device."]);
    }
  };

  const cancelTransfer = () => {
    console.log("CONSOLE: Cancelling transfer");
    if (transferEngineRef.current) {
      transferEngineRef.current.cancel();
      transferEngineRef.current = null;
    }
    // BUG 12 FIX: Use readyState directly
    controlConnRef.current.filter(c => c.readyState === 'open')
      .forEach(c => c.send(JSON.stringify({ type: "CANCEL_TRANSFER" })));

    // ── Partial file cleanup ─────────────────────────────────────────────────
    // Delete any partial file left by the cancelled transfer, regardless of
    // which storage path was used. Without this, every cancel leaves garbage.

    // Path 1 — showSaveFilePicker (user chose an explicit save location)
    if (streamFileHandleRef.current) {
      const fh = streamFileHandleRef.current;
      streamFileHandleRef.current = null;
      // FileSystemFileHandle.remove() available in Chrome 117+
      if (typeof fh.remove === 'function') {
        fh.remove().catch(() => {}); // silently ignore if already gone
      }
    }

    // Path 2 — showDirectoryPicker (silent save to chosen folder)
    if (saveDirectoryHandleRef.current && incomingFileRef.current?.name) {
      const nameToDelete = incomingFileRef.current.name;
      saveDirectoryHandleRef.current.removeEntry(nameToDelete).catch(() => {});
    }
    saveDirectoryHandleRef.current = null;
    hasSaveDirectoryRef.current = false;
    isChoosingDirectoryRef.current = false;
    directoryPickerDeclinedRef.current = false;

    // Path 3 — OPFS (gesture drop / mobile)
    if (opfsFileHandleRef.current) {
      const nameToDelete = incomingFileRef.current?.name;
      if (nameToDelete && navigator.storage?.getDirectory) {
        navigator.storage.getDirectory().then(root => {
          root.removeEntry(nameToDelete).catch(() => {});
        }).catch(() => {});
      }
      opfsFileHandleRef.current = null;
    }
    // ────────────────────────────────────────────────────────────────────────

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
    if (fileInputRef.current) { fileInputRef.current.value = ''; }
    setMessages((prev) => [...prev, `SYSTEM: Transfer cancelled.`]);
    if (socketRef.current) { socketRef.current.emit("dropped", roomCodeRef.current); }
    (window as any).onTransferCancelled?.();
  };

  const handleEngineComplete = (blob: Blob | null) => {
    if (isSourceRef.current) return;

    const meta = incomingFileRef.current;
    const fileName = meta?.name || "downloaded_file";
    const batchIndex = meta?.batchIndex ?? 0;
    const batchCount = meta?.batchCount ?? 1;
    const metaSize = meta?.size ?? 0;

    console.log(`CONSOLE: Finalizing file "${fileName}" (${blob ? 'buffered' : 'streamed to disk'})`);

    if (blob) {
      const newFile = {
        name: fileName,
        blob: blob,
        opfsHandle: null,
        id: Math.random().toString(36).substring(7)
      };
      setReceivedFiles(prev => [newFile, ...prev]);

      const url = URL.createObjectURL(blob);
      (window as any).onFileReceivedSuccess?.({
        name: fileName,
        size: blob.size,
        url,
        batchIndex,
        batchCount
      });
    }

    setIncomingFile(null);
    incomingFileRef.current = null;
    fileChunksRef.current = [];
    setTransferProgress(0);
    isTransferringRef.current = false;
    isTransferringFastRef.current = false;
    setIsTransferring(false);
    setTelemetry(null);
    streamFileHandleRef.current = null; // clear — file completed successfully, no cleanup needed
    if (transferEngineRef.current) {
      transferEngineRef.current.cleanup();
      transferEngineRef.current = null;
    }

    // BUG 12 FIX: Use readyState directly — critical, must send before any async I/O
    const openCtrlForComplete = controlConnRef.current.filter(c => c.readyState === 'open');
    if (openCtrlForComplete.length > 0) {
      console.log("CONSOLE: Sending TRANSFER_COMPLETE to peer");
      openCtrlForComplete.forEach(c => c.send(JSON.stringify({ type: "TRANSFER_COMPLETE" })));
    } else {
      console.error("CONSOLE: handleEngineComplete — no open control channels! TRANSFER_COMPLETE NOT sent. Sender will hang.");
    }

    if (blob) {
      saveFileAsync(blob, fileName);
    } else {
      if (opfsFileHandleRef.current) {
        // Streamed to OPFS — read file, add to panel, then auto-download
        const savedHandle = opfsFileHandleRef.current;
        opfsFileHandleRef.current = null;
        savedHandle.getFile().then((file: File) => {
          const fileBlob = file as unknown as Blob;
          setReceivedFiles(prev => [{
            name: fileName,
            blob: fileBlob,
            opfsHandle: savedHandle,   // keep alive — deleted after user saves
            id: Math.random().toString(36).substring(7)
          }, ...prev]);

          const url = URL.createObjectURL(file);
          (window as any).onFileReceivedSuccess?.({
            name: fileName,
            size: file.size,
            url,
            batchIndex,
            batchCount
          });

          // Auto-download the file (directory picker shown ONCE for first file, then silent)
          saveFileAsync(fileBlob, fileName);
        }).catch((err: any) => {
          console.error('Failed to retrieve OPFS file:', err);
          setMessages(prev => [...prev, `ERROR: Failed to read received file "${fileName}": ${err?.message ?? err}`]);
        });
      } else {
        setMessages(prev => [...prev, `SYSTEM: ✓ Saved to folder: ${fileName} directly to disk.`]);
        (window as any).onFileReceivedSuccess?.({
          name: fileName,
          size: metaSize,
          url: null,
          batchIndex,
          batchCount
        });
      }
    }
  };

  const saveFileAsync = async (blob: Blob, fileName: string) => {
    const fsaAvailable = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    let savedSilently = false;

    if (fsaAvailable && !directoryPickerDeclinedRef.current) {
      try {
        if (!hasSaveDirectoryRef.current && !isChoosingDirectoryRef.current) {
          isChoosingDirectoryRef.current = true;
          try {
            const dirHandle = await (window as any).showDirectoryPicker({
              mode: 'readwrite',
              startIn: 'downloads',
            });
            saveDirectoryHandleRef.current = dirHandle;
            hasSaveDirectoryRef.current = true;
          } catch (pickerErr: any) {
            if (pickerErr?.name === 'AbortError') {
              // User cancelled — remember so we never ask again this session
              directoryPickerDeclinedRef.current = true;
            } else {
              throw pickerErr; // re-throw for outer catch
            }
          } finally {
            isChoosingDirectoryRef.current = false;
          }
        } else if (!hasSaveDirectoryRef.current && isChoosingDirectoryRef.current) {
          let waitTime = 0;
          while (!hasSaveDirectoryRef.current && isChoosingDirectoryRef.current && waitTime < 15000) {
            await new Promise(r => setTimeout(r, 100));
            waitTime += 100;
          }
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
        if (err?.name !== 'AbortError') {
          console.warn('File System Access API write failed, falling back:', err);
        }
        hasSaveDirectoryRef.current = false;
        saveDirectoryHandleRef.current = null;
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
        setTimeout(() => URL.revokeObjectURL(url), 60_000); // 60s: gives Chrome time to fully read large blobs before revocation
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
    // Clear ICE watchdog
    if (iceWatchdogRef.current) { clearTimeout(iceWatchdogRef.current); iceWatchdogRef.current = null; }
    // Use cleanup() not destroy() — destroy() closes data channels before the PC does,
    // causing double-close errors and lost onmessage handlers on reconnect.
    if (transferEngineRef.current) {
      transferEngineRef.current.cleanup();
      transferEngineRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close(); // PC.close() closes all channels automatically
      pcRef.current = null;
    }
    connRef.current = [];
    controlConnRef.current = [];
    pendingCandidatesRef.current = [];
    setConnected(false);
    connectedRef.current = false;
    isTransferringFastRef.current = false;
    isTransferringRef.current = false;
    setIsTransferring(false);

    // Reset all transfer-specific states to prevent stale role configurations on reconnection
    setIsSource(false);
    isSourceRef.current = false;
    setIsGlobalLocked(false);
    isGlobalLockedRef.current = false;
    saveDirectoryHandleRef.current = null;
    hasSaveDirectoryRef.current = false;
    isChoosingDirectoryRef.current = false;
    directoryPickerDeclinedRef.current = false;
    setIncomingFile(null);
    incomingFileRef.current = null;
    setIsGrabbedPermanent(false);
    setSelectedFiles([]);
    selectedFilesRef.current = [];

    if (socketRef.current && roomCodeRef.current.length === 4) {
      setTimeout(() => {
        socketRef.current?.emit("join-room", { roomCode: roomCodeRef.current, clientId: clientIdRef.current });
      }, 100);
    }
  }, []);

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) { pcRef.current.close(); }
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
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
      ],
      // max-bundle: all data channels share one ICE path — critical on NAT/hotspot networks
      bundlePolicy: 'max-bundle' as RTCBundlePolicy,
      // Pre-gather a pool of ICE candidates before signaling starts for faster connection
      iceCandidatePoolSize: 3,
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit("ice-candidate", { roomId: roomCodeRef.current, candidate: event.candidate });
      } else {
        console.log("[ICE] Gathering complete.");
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log("[ICE] Connection State:", state);

      if (state === 'checking') {
        // Start a watchdog: if ICE is still 'checking' after 10s, it's stuck (common on
        // mobile hotspot where mDNS candidates silently fail). Force a full rejoin.
        if (iceWatchdogRef.current) clearTimeout(iceWatchdogRef.current);
        iceWatchdogRef.current = setTimeout(() => {
          if (pc.iceConnectionState === 'checking' && !connectedRef.current) {
            console.warn('[ICE] Watchdog: stuck in checking for 10s — forcing rejoin');
            pc.close();
            if (pcRef.current === pc) {
              pcRef.current = null;
              connRef.current = [];
              controlConnRef.current = [];
              pendingCandidatesRef.current = [];
            }
            if (socketRef.current?.connected && roomCodeRef.current.length === 4) {
              socketRef.current.emit('join-room', { roomCode: roomCodeRef.current, clientId: clientIdRef.current });
            }
          }
        }, 10000);
      } else if (state === 'connected' || state === 'completed') {
        // Clear watchdog — we made it
        if (iceWatchdogRef.current) { clearTimeout(iceWatchdogRef.current); iceWatchdogRef.current = null; }
        connectedRef.current = true;
        setConnected(true);
        // Re-register onbufferedamountlow after ICE selects its final candidate pair.
        // On mobile, ICE can promote to a new candidate pair after data channels open,
        // silently dropping threshold callbacks registered during initial channel setup.
        if (transferEngineRef.current) {
          transferEngineRef.current.tuneSocketBuffers();
          console.log('[ICE] Re-tuned socket buffers after ICE connected');
        }
      } else if (state === 'disconnected') {
        // Transient disconnect — try ICE restart first
        connectedRef.current = false;
        setConnected(false);
        console.log("[ICE] Disconnected — attempting ICE restart");
        try { pc.restartIce(); } catch (e) { console.warn('[ICE] restartIce() not supported:', e); }
      } else if (state === 'failed') {
        // Full ICE failure — tear down and restart signaling after 1.5s
        if (iceWatchdogRef.current) { clearTimeout(iceWatchdogRef.current); iceWatchdogRef.current = null; }
        connectedRef.current = false;
        setConnected(false);
        if (isTransferringRef.current) {
          console.warn("[ICE] ICE failed mid-transfer! Cancelling transfer and showing error.");
          cancelTransfer();
          (window as any).showPeerDisconnected?.(true);
        }
        console.log("[ICE] Failed — tearing down and restarting WebRTC handshake in 1.5s...");
        pc.close();
        if (pcRef.current === pc) {
          pcRef.current = null;
          connRef.current = [];
          controlConnRef.current = [];
          pendingCandidatesRef.current = [];
        }
        setTimeout(() => {
          if (!connectedRef.current && socketRef.current?.connected && roomCodeRef.current.length === 4) {
            console.log("[ICE] Re-emitting join-room to restart signaling...");
            socketRef.current.emit("join-room", { roomCode: roomCodeRef.current, clientId: clientIdRef.current });
          }
        }, 1500);
      }
    };

    // connectionState is a more holistic signal than iceConnectionState (includes DTLS).
    // This acts as a backup trigger for setConnected(true) if iceConnectionState fires late.
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log("[WebRTC] Connection State:", state);
      if (state === 'connected') {
        connectedRef.current = true;
        setConnected(true);
      } else if (state === 'failed') {
        // Already handled by iceconnectionstatechange above
        connectedRef.current = false;
        setConnected(false);
      }
    };

    pcRef.current = pc;
    return pc;
  }, []);

  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';

    // BUG 6 FIX: extract onopen body into named function so we can detect
    // channels that already opened before the handler was registered (LAN race).
    // BUG 7 FIX: synchronously update connectedRef BEFORE React state to close the 16ms window.
    // BUG 3 FIX: check both connRef AND controlConnRef independently with .every(open).
    const handleOpen = () => {
      console.log(`DataChannel ${dc.label} is open (readyState: ${dc.readyState})`);

      const allDataOpen = connRef.current.length > 0 && connRef.current.every(c => c.readyState === 'open');
      const ctrlOpen = controlConnRef.current.length > 0 && controlConnRef.current.every(c => c.readyState === 'open');
      const totalOpen = connRef.current.filter(c => c.readyState === 'open').length +
                        controlConnRef.current.filter(c => c.readyState === 'open').length;
      const expectedTotal = 2; // 1 data + 1 control

      if (allDataOpen && ctrlOpen && totalOpen >= expectedTotal) {
        console.log("All 2 channels open! Setting connected = true");
        // BUG 7 FIX: sync ref update before React state (no 16ms vulnerability)
        connectedRef.current = true;
        setConnected(true);

        if (transferEngineRef.current) {
          transferEngineRef.current.setConnections(connRef.current, controlConnRef.current);
        }

        const currentFile = selectedFilesRef.current[currentFileIndexRef.current];
        // BUG FIX (laptop→phone direction): isSourceRef.current may still be false here
        // because the global-lock socket round-trip races with WebRTC channel opening.
        // We also check selectedFilesRef directly — if we have a file selected, we ARE the
        // sender regardless of whether the socket event has updated the ref yet.
        const iAmSender = isSourceRef.current || (currentFile != null && isGlobalLockedRef.current);
        if (iAmSender && currentFile && controlConnRef.current.length > 0) {
          console.log("CONSOLE: Resending FILE_META on channel open (iAmSender check: isSourceRef=", isSourceRef.current, "hasFile=", !!currentFile, "isGlobalLocked=", isGlobalLockedRef.current, ")");
          const metaPayload = JSON.stringify({
            type: "FILE_META",
            // U2: reuse the minted transferId instead of minting a fresh one per
            // resend — otherwise sender and receiver can disagree on the id and
            // the resume handshake is refused as "unknown transferId" (KTD2).
            transferId: transferIdRef.current ?? mintTransferId(),
            file: {
              name: currentFile.name,
              type: currentFile.type,
              size: currentFile.size,
              totalChunks: Math.ceil(currentFile.size / CHUNK_SIZE),
              chunkSize: CHUNK_SIZE,
              batchIndex: currentFileIndexRef.current,
              batchCount: selectedFilesRef.current.length
            }
          });
          controlConnRef.current.forEach(c => {
            if (c.readyState === 'open') c.send(metaPayload);
          });
        } else if (!iAmSender && currentFile && !isGlobalLockedRef.current) {
          // Channels just opened and we have a file but room isn't locked yet — grab was likely
          // emitted just before channels opened. Send FILE_META proactively; the grab event
          // will lock the room on both sides shortly after.
          console.log("CONSOLE: Channels opened with file selected but room not locked yet — sending FILE_META proactively");
          const metaPayload = JSON.stringify({
            type: "FILE_META",
            transferId: transferIdRef.current ?? mintTransferId(),
            file: {
              name: currentFile.name,
              type: currentFile.type,
              size: currentFile.size,
              totalChunks: Math.ceil(currentFile.size / CHUNK_SIZE),
              chunkSize: CHUNK_SIZE,
              batchIndex: currentFileIndexRef.current,
              batchCount: selectedFilesRef.current.length
            }
          });
          controlConnRef.current.forEach(c => {
            if (c.readyState === 'open') c.send(metaPayload);
          });
        }

        if (!isSourceRef.current && isGlobalLockedRef.current && incomingFileRef.current && transferRequestedRef.current && transferEngineRef.current) {
          const resumeManifest = transferEngineRef.current.getReceivedManifest();
          console.log(`CONSOLE: Resuming transfer with ${resumeManifest.length} already-received chunks`);
          isTransferringRef.current = true;
          setIsTransferring(true);
          controlConnRef.current.forEach(c => {
            if (c.readyState === 'open') {
              c.send(JSON.stringify({ type: "START_TRANSFER", resumeManifest }));
            }
          });
        } else if (isSourceRef.current && transferIdRef.current && isTransferringRef.current) {
          // U4 (R1/R2): the sender's channels re-established mid-transfer (e.g.
          // after a backgrounding that dropped WebRTC). The receiver is the
          // authority on progress, so probe it for its manifest — the
          // RESUME_MANIFEST reply re-arms the sender engine (U3).
          console.log(`CONSOLE: Channels reopened mid-transfer — sending RESUME_REQUEST for ${transferIdRef.current}`);
          const req = JSON.stringify({ type: "RESUME_REQUEST", transferId: transferIdRef.current });
          controlConnRef.current.forEach(c => {
            if (c.readyState === 'open') c.send(req);
          });
        }
        if (pendingStartTransferRef.current && connRef.current.some(c => c.readyState === 'open')) {
          console.log("CONSOLE: Data channel opened — executing pending transfer!");
          const pending = pendingStartTransferRef.current;
          pendingStartTransferRef.current = null;
          executeTransfer(pending.file, pending.resumeManifest);
        }
      } else {
        console.log(`DataChannel ${dc.label} open. Waiting for remaining channels... (data: ${connRef.current.filter(c=>c.readyState==='open').length}/${connRef.current.length}, ctrl: ${controlConnRef.current.filter(c=>c.readyState==='open').length}/${controlConnRef.current.length})`);
      }
    };

    dc.onopen = handleOpen;
    // BUG 6 FIX: if channel already open before handler registered (LAN race),
    // call handleOpen via queueMicrotask so all ondatachannel push() calls complete first.
    if (dc.readyState === 'open') {
      console.log(`[LAN-fix] DataChannel ${dc.label} was already open — deferring handleOpen() via microtask`);
      queueMicrotask(handleOpen);
    }

    dc.onclose = () => {
      console.log(`DataChannel ${dc.label} closed`);
      if (dc.label === 'control') {
        controlConnRef.current = controlConnRef.current.filter(c => c !== dc);
      } else {
        connRef.current = connRef.current.filter(c => c !== dc);
      }
      if (connRef.current.length === 0 && controlConnRef.current.length === 0) {
        setConnected(false);
        connectedRef.current = false;
        if (isTransferringRef.current) {
          console.warn("CONSOLE: WebRTC channels closed mid-transfer! Cancelling and showing error.");
          cancelTransfer();
          (window as any).showPeerDisconnected?.(true);
        } else {
          transferEngineRef.current?.destroy();
          transferEngineRef.current = null;
        }
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
          try {
            if (data instanceof ArrayBuffer) {
              buffer = data;
            } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
              buffer = await data.arrayBuffer();
            } else if (data && typeof (data as any).buffer === 'object') {
              // TypedArray: extract the correct slice to avoid SharedArrayBuffer offset issues
              const raw = data as any;
              buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            } else {
              console.warn('[Control] Unrecognized binary format, skipping ACK batch');
              return;
            }
          } catch (convErr) {
            console.error('[Control] Failed to convert incoming ACK data to ArrayBuffer:', convErr);
            return;
          }

          if (buffer.byteLength >= 5 && buffer.byteLength % 5 === 0) {
            const view = new DataView(buffer);
            const messageCount = buffer.byteLength / 5;
            for (let i = 0; i < messageCount; i++) {
              const type = view.getUint8(i * 5);
              const index = view.getUint32(i * 5 + 1, true);
              if (type === 0x02) {
                transferEngineRef.current?.processAck(index);
              } else if (type === 0x03) {
                transferEngineRef.current?.processNack(index);
              }
            }
            return;
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
            incomingTransferIdRef.current = payload.transferId ?? null;

            const prevEngine = transferEngineRef.current;
            if (prevEngine) {
              // BUG 14 FIX: Use cleanup() — not the non-existent destroy() method
              prevEngine.cleanup();
              transferEngineRef.current = null;
            }

            const newEngine = new TransferEngine(connRef.current);
            newEngine.setControlConnections(controlConnRef.current);
            transferEngineRef.current = newEngine;
            newEngine.setCallbacks(
              (t) => { setTelemetry(t); setTransferProgress(t.progress); },
              (blob) => {
                if (blob instanceof Blob) handleEngineComplete(blob);
                else if (blob === null) handleEngineComplete(null);
                else console.log("CONSOLE: Sender finished. Waiting for TRANSFER_COMPLETE.");
              }
            );
            newEngine.initReceiver(payload.file);

            if (typeof (window as any).triggerIncomingSphere === 'function') {
              (window as any).triggerIncomingSphere(
                payload.file.name,
                payload.file.size,
                payload.file.batchIndex,
                payload.file.batchCount
              );
            }

            if (pendingDropActionRef.current) {
              console.log("CONSOLE: Pending drop action resolved on FILE_META arrival — initiating drop action!");
              pendingDropActionRef.current = false;
              setTimeout(() => {
                handleDropAction();
              }, 50);
            }

            // Save location is chosen in handleDropAction (button) or falls through to
            // OPFS (gesture path). Do not call showSaveFilePicker here — FILE_META
            // arrives via WebRTC message, which is not a browser user-gesture context.

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
                console.log(`[Stream] Ready → streaming "${payload.file.name}" to folder`);
              } catch (streamErr) {
                console.warn('[Stream] Failed to open file for streaming:', streamErr);
              }
            } else if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
              try {
                // OPFS Fallback for Mobile Devices (Zero-RAM streaming)
                const root = await navigator.storage.getDirectory();
                const fh = await root.getFileHandle(payload.file.name, { create: true });
                // CRITICAL: set the ref BEFORE createWritable() so cancelTransfer() can
                // find and delete the OPFS file even if cancel happens during async setup.
                opfsFileHandleRef.current = fh;
                if ('createWritable' in fh) {
                  const wr = await (fh as any).createWritable();
                  if (payload.file.size > 0) {
                    await wr.truncate(payload.file.size);
                  }
                  newEngine.setStreamWriter(wr);
                  console.log(`[Stream] Ready → streaming "${payload.file.name}" to OPFS virtual disk`);
                } else {
                  opfsFileHandleRef.current = null;
                }
              } catch (opfsErr) {
                opfsFileHandleRef.current = null; // failed to set up, clear the ref
                console.warn('[Stream] Failed to initialize OPFS fallback. Will use RAM buffer:', opfsErr);
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
            setMessages(prev => [...prev, "SYSTEM: Received START_TRANSFER from peer. Checking files..."]);
            const fileToSend = selectedFilesRef.current[currentFileIndexRef.current];
            if (fileToSend) {
              const openDataChans = connRef.current.filter(c => c.readyState === 'open');
              if (openDataChans.length > 0) {
                executeTransfer(fileToSend, payload.resumeManifest || []);
              } else {
                console.warn("CONSOLE: Received START_TRANSFER but data channels not open yet — queuing pendingStartTransfer.");
                pendingStartTransferRef.current = { file: fileToSend, resumeManifest: payload.resumeManifest || [] };
              }
            } else {
              setMessages(prev => [...prev, "ERROR: Received START_TRANSFER but no file is selected (selectedFiles is empty)."]);
            }

          } else if (payload.type === "RESUME_REQUEST") {
            // U2 (KTD2): the sender asks the receiver for its current manifest.
            // The receiver is the sole authority on progress; it replies from
            // getReceivedManifest(), which returns [] when it can no longer
            // produce its chunks (R4), forcing a restart from 0 instead of a
            // corrupt file. A stale/unknown transferId is ignored (AE2).
            if (incomingTransferIdRef.current && payload.transferId === incomingTransferIdRef.current) {
              const manifest = transferEngineRef.current?.getReceivedManifest() ?? [];
              console.log(`[Visibility] Sending RESUME_MANIFEST for ${manifest.length} chunks`);
              const reply = JSON.stringify({ type: "RESUME_MANIFEST", transferId: payload.transferId, manifest });
              controlConnRef.current.filter(c => c.readyState === 'open').forEach(c => c.send(reply));
            } else {
              console.log("[Visibility] Ignoring RESUME_REQUEST with unknown transferId", payload.transferId);
            }

          } else if (payload.type === "RESUME_MANIFEST") {
            // U2: receiver-published progress. U3 re-arms the sender from it;
            // here the transferId is matched so a stale manifest from a previous
            // cancelled transfer can never re-seed the current one (KTD3/AE2).
            if (isSourceRef.current && transferIdRef.current && payload.transferId === transferIdRef.current && isTransferringRef.current) {
              const manifest: number[] = Array.isArray(payload.manifest) ? payload.manifest : [];
              console.log(`[Visibility] Received RESUME_MANIFEST with ${manifest.length} chunks`);
              resumeManifestRef.current = manifest;
              const engine = transferEngineRef.current;
              if (engine) {
                console.log(`[Visibility] Re-arming sender engine from manifest (${manifest.length} chunks)`);
                engine.resumeTransfer(manifest);
              }
            } else {
              console.log("[Visibility] Ignoring RESUME_MANIFEST (unknown transferId or not the sender)", payload.transferId);
            }

          } else if (payload.type === "CANCEL_TRANSFER") {
            console.log("CONSOLE: Received CANCEL_TRANSFER from peer.");
            if (transferEngineRef.current) {
              transferEngineRef.current.cancel();
            }
    // ── Partial file cleanup (same 3 paths as cancelTransfer) ───────────────
    if (streamFileHandleRef.current) {
      const fh = streamFileHandleRef.current;
      streamFileHandleRef.current = null;
      if (typeof fh.remove === 'function') { fh.remove().catch(() => {}); }
    }
    if (saveDirectoryHandleRef.current && incomingFileRef.current?.name) {
      saveDirectoryHandleRef.current.removeEntry(incomingFileRef.current.name).catch(() => {});
    }
    if (opfsFileHandleRef.current) {
      const nameToDelete = incomingFileRef.current?.name;
      if (nameToDelete && navigator.storage?.getDirectory) {
        navigator.storage.getDirectory().then(root => {
          root.removeEntry(nameToDelete).catch(() => {});
        }).catch(() => {});
      }
      opfsFileHandleRef.current = null;
    }
    // ────────────────────────────────────────────────────────────────────────
            setIncomingFile(null);
            incomingFileRef.current = null;
            fileChunksRef.current = [];
            setTransferProgress(0);
            transferRequestedRef.current = false;
            isTransferringFastRef.current = false;
            isTransferringRef.current = false;
            setIsTransferring(false);
            setSelectedFiles([]);
            selectedFilesRef.current = [];
            setCurrentFileIndex(0);
            currentFileIndexRef.current = 0;
            setTelemetry(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            setMessages((prev) => [...prev, `SYSTEM: Peer cancelled the transfer.`]);
            (window as any).onTransferCancelled?.();


          } else if (payload.type === "TRANSFER_COMPLETE") {
            console.log("CONSOLE: Received TRANSFER_COMPLETE from peer");
            isTransferringRef.current = false;
            isTransferringFastRef.current = false;
            setIsTransferring(false);
            setTelemetry(null);
            if (transferEngineRef.current) {
              transferEngineRef.current.resetForNextFile(connRef.current, controlConnRef.current);
            }

            const nextIdx = currentFileIndexRef.current + 1;
            if (nextIdx < selectedFilesRef.current.length) {
              setCurrentFileIndex(nextIdx);
              currentFileIndexRef.current = nextIdx;
              const nextFile = selectedFilesRef.current[nextIdx];
              setMessages((prev) => [...prev, `SYSTEM: File sent successfully. Preparing next file: ${nextFile.name} (${nextIdx + 1}/${selectedFilesRef.current.length})`]);

              // BUG 12 FIX: readyState direct check
              controlConnRef.current.filter(c => c.readyState === 'open').forEach(c => {
                c.send(JSON.stringify({
                  type: "FILE_META",
                  transferId: mintTransferId(),
                  file: {
                    name: nextFile.name,
                    type: nextFile.type,
                    size: nextFile.size,
                    totalChunks: Math.ceil(nextFile.size / CHUNK_SIZE),
                    chunkSize: CHUNK_SIZE,
                    batchIndex: nextIdx,
                    batchCount: selectedFilesRef.current.length
                  }
                }));
              });
            } else {
              // Call success screen trigger in Ch3 before clearing state
              if (typeof (window as any)._completeTransferCh3 === 'function') {
                (window as any)._completeTransferCh3();
              }

              setMessages((prev) => [...prev, `SYSTEM: All ${selectedFilesRef.current.length} file(s) sent successfully!`]);
              setSelectedFiles([]);
              selectedFilesRef.current = [];
              setCurrentFileIndex(0);
              currentFileIndexRef.current = 0;
              if (fileInputRef.current) fileInputRef.current.value = '';

              controlConnRef.current.filter(c => c.readyState === 'open')
                .forEach(c => c.send(JSON.stringify({ type: "ALL_FILES_DONE" })));

              if (socketRef.current) {
                console.log("CONSOLE: All files sent. Emitting 'dropped' to unlock room.");
                socketRef.current.emit("dropped", roomCodeRef.current);
              }
            }

          } else if (payload.type === "REQUEST_FILE_META") {
            console.log("CONSOLE: Received REQUEST_FILE_META from receiver. Resending FILE_META...");
            const currentFile = selectedFilesRef.current[currentFileIndexRef.current];
            if (currentFile) {
              const meta = JSON.stringify({
                type: "FILE_META",
                transferId: transferIdRef.current ?? mintTransferId(),
                file: {
                  name: currentFile.name,
                  type: currentFile.type,
                  size: currentFile.size,
                  totalChunks: Math.ceil(currentFile.size / CHUNK_SIZE),
                  chunkSize: CHUNK_SIZE,
                  batchIndex: currentFileIndexRef.current,
                  batchCount: selectedFilesRef.current.length
                }
              });
              dc.send(meta);
            }

          } else if (payload.type === "ALL_FILES_DONE") {
            console.log("CONSOLE: Received ALL_FILES_DONE from peer");
            setMessages((prev) => [...prev, `SYSTEM: All files have been received.`]);
            transferRequestedRef.current = false;
            saveDirectoryHandleRef.current = null;
            hasSaveDirectoryRef.current = false;
            isChoosingDirectoryRef.current = false;
            directoryPickerDeclinedRef.current = false;

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

          // BUG 5 FIX: >= HEADER_SIZE (not > HEADER_SIZE), to accept zero-payload packets
          if (buffer.byteLength >= HEADER_SIZE) {
            transferEngineRef.current?.enqueueChunk(buffer);
          }
        }
      };
    }
  }, []);

  const setupOfferer = useCallback(async () => {
    const pc = createPeerConnection();

    const DATA_CHANNEL_COUNT = 1;
    const dataConnsRaw: RTCDataChannel[] = [];
    const controlConnsRaw: RTCDataChannel[] = [];

    for (let i = 0; i < DATA_CHANNEL_COUNT; i++) {
      const dc = pc.createDataChannel(`data${i}`, { ordered: true });
      // BUG 15 FIX: push to ref BEFORE calling setupDataChannel
      dataConnsRaw.push(dc);
    }
    const controlDc = pc.createDataChannel('control', { ordered: true });
    // BUG 15 FIX: push to ref BEFORE calling setupDataChannel
    controlConnsRaw.push(controlDc);

    // Assign all refs before setup so handleOpen sees complete arrays
    connRef.current = dataConnsRaw;
    controlConnRef.current = controlConnsRaw;

    // Now call setupDataChannel for each
    for (const dc of dataConnsRaw) {
      setupDataChannel(dc);
    }
    setupDataChannel(controlDc);

    // onnegotiationneeded: fires when pc.restartIce() is called after a disconnect.
    // The offerer must re-send an updated offer with iceRestart=true for the restart to work.
    pc.onnegotiationneeded = async () => {
      // Only re-negotiate when stable (ignore spurious fires during initial setup)
      if (pc.signalingState !== 'stable') {
        console.log('[WebRTC] onnegotiationneeded fired but signalingState is', pc.signalingState, '— ignoring');
        return;
      }
      // Ignore the very first negotiation (initial offer is sent below)
      if (!connectedRef.current && pc.iceConnectionState === 'new') return;
      console.log('[WebRTC] onnegotiationneeded — sending ICE restart offer');
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        socketRef.current?.emit("offer", { roomId: roomCodeRef.current, sdp: offer });
      } catch (e) {
        console.error('[WebRTC] Failed to create ICE restart offer:', e);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current?.emit("offer", { roomId: roomCodeRef.current, sdp: offer });
  }, [createPeerConnection, setupDataChannel]);

  const setupAnswerer = useCallback(async () => {
    connRef.current = [];
    controlConnRef.current = [];
    const pc = createPeerConnection();

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      // BUG 15 FIX: push to ref BEFORE calling setupDataChannel so handleOpen
      // sees all channels already in the array
      if (dc.label === 'control') {
        controlConnRef.current.push(dc);
      } else if (dc.label.startsWith('data')) {
        connRef.current.push(dc);
      }
      setupDataChannel(dc);
    };
  }, [createPeerConnection, setupDataChannel]);

  const handleJoin = async () => {
    if (roomCode.length === 4 && socketRef.current) {
      console.log("Joining room:", roomCode);
      socketRef.current.emit("join-room", { roomCode, clientId: clientIdRef.current });

      if (backgroundAudioRef.current) {
        try {
          await backgroundAudioRef.current.play();
          console.log("[BackgroundMode] Silent audio playing, connection will stay alive in background.");
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: 'Nexus Spatial Share',
              artist: 'Background Connection Active',
            });
          }
        } catch (e) {
          console.warn("[BackgroundMode] Could not play silent audio:", e);
        }
      }
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

  const simulateGrab = () => { socketRef.current?.emit("grabbed", roomCodeRef.current); };
  const simulateDrop = () => { socketRef.current?.emit("dropped", roomCodeRef.current); };

  const dumpDiagnostics = () => {
    const dataChannelStates = connRef.current.map(c => `${c.label}:${c.readyState}`);
    const ctrlChannelStates = controlConnRef.current.map(c => `${c.label}:${c.readyState}`);
    const lines = [
      `=== DIAGNOSTICS ==========================`,
      `Socket: ${isSocketConnected ? 'connected' : 'DISCONNECTED'} | ID: ${socketRef.current?.id ?? 'none'}`,
      `Room: "${roomCodeRef.current}" | Joined: ${joinedRef.current} | P2P Connected: ${connected}`,
      `Data channels (${connRef.current.length}): ${dataChannelStates.join(', ') || 'none'}`,
      `Ctrl channels (${controlConnRef.current.length}): ${ctrlChannelStates.join(', ') || 'none'}`,
      `isGlobalLocked: ${isGlobalLocked} | isSource: ${isSource}`,
      `incomingFile: ${incomingFileRef.current ? incomingFileRef.current.name : 'null'}`,
      `selectedFiles: ${selectedFilesRef.current.length} | currentIdx: ${currentFileIndexRef.current}`,
      `isTransferring: ${isTransferringRef.current} | transferRequested: ${transferRequestedRef.current}`,
      `==========================================`,
    ];
    lines.forEach(l => console.log('DIAG:', l));
    setMessages(prev => [...prev, ...lines]);
  };

  // --- PHASE 4 BRIDGE HOOKS ---
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  };

  // --- FILE OVERLAY UPDATE ON METADATA ---
  useEffect(() => {
    const overlay = document.getElementById('file-overlay');
    const nameEl = document.getElementById('overlay-name');
    const sizeEl = document.getElementById('overlay-size');
    if (incomingFile && overlay && nameEl && sizeEl) {
      nameEl.textContent = incomingFile.name;
      sizeEl.textContent = formatBytes(incomingFile.size);
      overlay.classList.add('active');
    } else if (overlay) {
      overlay.classList.remove('active');
    }
  }, [incomingFile]);

  // --- CONTROL PANEL & BUTTON STATES SYNC ---
  useEffect(() => {
    const controlPanel = document.getElementById('control-panel');
    const btnGrab = document.getElementById('btn-grab');
    const btnDrop = document.getElementById('btn-drop');

    if (!controlPanel || !btnGrab || !btnDrop) return;

    if (isGlobalLocked) {
      if (isSource) {
        // We are the sender and the room is locked (we grabbed). Hide control panel.
        controlPanel.classList.remove('visible');
      } else {
        // We are the receiver and the room is locked (sender grabbed).
        // Show control panel with Drop button.
        controlPanel.classList.add('visible');
        (btnGrab as HTMLButtonElement).style.display = 'none';
        (btnDrop as HTMLButtonElement).style.display = 'flex';
        (btnDrop as HTMLButtonElement).disabled = false;
      }
    } else {
      // Room is not locked.
      if (selectedFiles.length > 0) {
        // We have files selected, show grab button.
        controlPanel.classList.add('visible');
        (btnGrab as HTMLButtonElement).style.display = 'flex';
        (btnGrab as HTMLButtonElement).disabled = false;
        (btnDrop as HTMLButtonElement).style.display = 'none';
      } else {
        // No files selected, hide control panel.
        controlPanel.classList.remove('visible');
      }
    }
  }, [isGlobalLocked, isSource, selectedFiles, incomingFile]);

  useEffect(() => {
    if (isSocketConnected) (window as any).Signaling?.onConnect();
    else (window as any).Signaling?.onDisconnect();
  }, [isSocketConnected]);

  useEffect(() => {
    if (joined && roomCode) {
      const safeCode = typeof roomCode === 'object' ? '' : String(roomCode);
      if (safeCode) {
        (window as any).Signaling?.setRoomCode(safeCode);
        (window as any).transitionToSender?.(safeCode);
      }
    }
  }, [joined, roomCode]);

  useEffect(() => {
    if (connected) (window as any).Signaling?.onPeerJoined('peer');
  }, [connected]);

  useEffect(() => {
    if (connected) (window as any).Signaling?.onWebRTCOpen();
    else (window as any).Signaling?.onWebRTCClose();
  }, [connected]);

  useEffect(() => {
    const hasFiles = selectedFiles.length > 0;
    (window as any).updateGrabButtonState?.(hasFiles, isGlobalLocked, isSource);
    (window as any).updateDropButtonState?.(!!incomingFile, isGlobalLocked, isSource, isGrabbedPermanent);
  }, [selectedFiles, isGlobalLocked, isSource, incomingFile, isGrabbedPermanent]);

  useEffect(() => {
    if (isTransferring && isSource) {
      (window as any).updateSenderProgress?.(
        transferProgress / 100,
        telemetry?.speedMBps ?? 0,
        currentFileIndex,
        selectedFiles.length
      );
    }
    if (isTransferring && !isSource) {
        (window as any).updateReceiverProgress?.(transferProgress / 100, telemetry?.speedMBps ?? 0);
    }
  }, [isTransferring, isSource, transferProgress, telemetry, currentFileIndex, selectedFiles]);

  // U1 — the transfer phase bridge (R9/R11). One authoritative value from React
  // to the DOM layer so the escape hatch can stop inferring state from screen
  // visibility. `stalled` stays unreachable until U5 writes isTransferStalled;
  // `requested` (receiver dropped, no chunk yet) vs `active` is decided by
  // whether the engine has reported at least one chunk / ACK. Depend on the
  // string so a re-render with unchanged inputs does not re-fire the bridge.
  const transferPhase: 'idle' | 'requested' | 'active' | 'stalled' = isTransferStalled
    ? 'stalled'
    : !isTransferring
      ? 'idle'
      : transferRequestedRef.current && !(telemetry && telemetry.chunksSent > 0)
        ? 'requested'
        : 'active';

  useEffect(() => {
    window.setTransferPhase?.(transferPhase);
  }, [transferPhase]);

  useEffect(() => {
    if (cameraError) (window as any).showCameraDeniedBanner?.();
  }, [cameraError]);

  useEffect(() => {
    // ── Expose socket hooks for Ch2/Ch3 native scripts ──
    // Ch2's joinRoom() checks _socketIsConnected and _socketJoinRoom before
    // falling back to the role-picker UI. Exposing these ensures Ch2/Ch3 route
    // through the real socket instead of showing the dev role picker.
    (window as any)._socketIsConnected = () => !!socketRef.current?.connected;
    (window as any)._socketIsLocked = () => isGlobalLockedRef.current;

    (window as any)._socketJoinRoom = (code: string) => {
      setRoomCode(code);
      socketRef.current?.emit('join-room', { roomCode: code, clientId: clientIdRef.current });
    };

    (window as any)._socketCreateRoom = (code: string) => {
      setRoomCode(code);
      socketRef.current?.emit('join-room', { roomCode: code, clientId: clientIdRef.current });
    };

    // ── file-input: sync React state so App.tsx knows which files to send ──
    (window as any).onFilesSelected = (files: File[]) => {
      setSelectedFiles(files);
      selectedFilesRef.current = files;
    };
    (window as any).sendFilesViaWebRTC = (files: File[]) => {
      // Stub to prevent index.html from starting fake transfer
      console.log("[App.tsx] sendFilesViaWebRTC called (intercepted by App.tsx)");
    };

    const handleBtnGrabClick = () => {
      handleGrabAction();
      socketRef.current?.emit('grabbed', roomCodeRef.current);
    };

    const handleBtnDropClick = () => {
      handleDropAction();
    };

    const handleBtnLeaveClick = () => {
      socketRef.current?.emit('dropped', roomCodeRef.current);
      socketRef.current?.emit('leave-room');
      roomCodeRef.current = ''; // Force update Ref immediately to prevent auto-rejoin in resetWebRTCConnection
      resetWebRTCConnection();
      setJoined(false);
      setConnected(false);
      setSelectedFiles([]);
      setRoomCode('');
      (window as any).leaveRoom?.();
    };

    const handleBtnDownloadMainClick = () => {
      // patched by HTML logic when file received
    };

    const handleBtnRxLeaveClick = () => {
      (window as any).leaveReceiver?.();
    };

    const handleBtnErrorRetryClick = () => {
      cancelTransfer();
    };

    const handleBtnClearFilesClick = () => {
      if (navigator.storage && navigator.storage.getDirectory) {
        navigator.storage.getDirectory().then(async (root) => {
          try {
            // @ts-ignore
            const entries = root.entries ? root.entries() : null;
            if (entries) {
              for await (const [name] of entries) {
                await root.removeEntry(name, { recursive: true }).catch(() => {});
              }
            } else {
              // @ts-ignore
              const keys = root.keys ? root.keys() : null;
              if (keys) {
                for await (const name of keys) {
                  await root.removeEntry(name, { recursive: true }).catch(() => {});
                }
              }
            }
          } catch (err) {
            console.error('Failed to wipe OPFS directory:', err);
          }
        }).catch(() => {});
      }
      setReceivedFiles([]);
    };

    const btnGrab = document.getElementById('btn-grab');
    const btnDrop = document.getElementById('btn-drop');
    const btnLeave = document.getElementById('btn-leave');
    const btnDownloadMain = document.getElementById('btn-download-main');
    const btnRxLeave = document.getElementById('btn-rx-leave');
    const btnErrorRetry = document.getElementById('btn-error-retry');
    const btnClearFiles = document.getElementById('btn-clear-files');

    btnGrab?.addEventListener('click', handleBtnGrabClick);
    btnDrop?.addEventListener('click', handleBtnDropClick);
    btnLeave?.addEventListener('click', handleBtnLeaveClick);
    btnDownloadMain?.addEventListener('click', handleBtnDownloadMainClick);
    btnRxLeave?.addEventListener('click', handleBtnRxLeaveClick);
    btnErrorRetry?.addEventListener('click', handleBtnErrorRetryClick);
    btnClearFiles?.addEventListener('click', handleBtnClearFilesClick);

    // Real complete transfer callback remains intact (handled by Ch3 in index.html)

    (window as any)._socketLeaveRoom = () => {
      socketRef.current?.emit('leave-room');
      roomCodeRef.current = ''; // Force update Ref immediately to prevent auto-rejoin in resetWebRTCConnection
      resetWebRTCConnection();
      setJoined(false);
      setConnected(false);
      setSelectedFiles([]);
      setRoomCode('');
    };

    (window as any)._socketCancelTransfer = () => {
      cancelTransfer();
    };

    // U2: debug/probe trigger for the resume handshake. U4 replaces manual
    // console driving with the real visibility returning-to-foreground logic.
    (window as any)._socketDebugResumeRequest = () => {
      if (!transferIdRef.current || !isTransferringRef.current) {
        console.warn("[Visibility] Debug resume: no in-flight transfer to probe");
        return;
      }
      const req = JSON.stringify({ type: "RESUME_REQUEST", transferId: transferIdRef.current });
      controlConnRef.current.filter(c => c.readyState === 'open').forEach(c => c.send(req));
      console.log(`[Visibility] Debug resume: sent RESUME_REQUEST for ${transferIdRef.current}`);
    };

    return () => {
      btnGrab?.removeEventListener('click', handleBtnGrabClick);
      btnDrop?.removeEventListener('click', handleBtnDropClick);
      btnLeave?.removeEventListener('click', handleBtnLeaveClick);
      btnDownloadMain?.removeEventListener('click', handleBtnDownloadMainClick);
      btnRxLeave?.removeEventListener('click', handleBtnRxLeaveClick);
      btnErrorRetry?.removeEventListener('click', handleBtnErrorRetryClick);
      btnClearFiles?.removeEventListener('click', handleBtnClearFilesClick);

      delete (window as any)._socketIsConnected;
      delete (window as any)._socketIsLocked;
      delete (window as any)._socketJoinRoom;
      delete (window as any)._socketCreateRoom;
      delete (window as any).onFilesSelected;
      delete (window as any).sendFilesViaWebRTC;
      // _completeTransferCh3 is deliberately NOT deleted here: index.html sets
      // it once at parse time and this effect never re-creates it, so deleting
      // it on cleanup removed it permanently. Under StrictMode's
      // mount/cleanup/mount cycle that killed the sender's success path — no
      // success screen and, since this branch, no resetTransferVisuals() either,
      // leaving the transfer rings running forever after a successful send.
      delete (window as any)._socketLeaveRoom;
      delete (window as any)._socketCancelTransfer;
      delete (window as any)._socketDebugResumeRequest;
    };


  }, []);

  return (
    <div style={{ display: "none", position: "fixed", top: 0, left: 0, zIndex: -1 }} aria-hidden="true">
      <video ref={videoRef} playsInline muted style={{ width: 320, height: 240 }} />
      <canvas ref={canvasRef} width={320} height={240} />
    </div>
  );
}


