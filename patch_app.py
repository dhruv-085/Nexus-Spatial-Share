import re

file_path = r"d:\Projects\Nexus Spatial Share\Website Code\nexus-spatial-share\src\App.tsx"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# 1. Imports
text = text.replace('import Peer, { DataConnection } from "peerjs";\n', '')

# 2. Refs
text = text.replace('const peerRef = useRef<Peer | null>(null);', 'const pcRef = useRef<RTCPeerConnection | null>(null);')
text = text.replace('const connRef = useRef<DataConnection[]>([]);', 'const connRef = useRef<RTCDataChannel[]>([]);')
text = text.replace('const controlConnRef = useRef<DataConnection[]>([]);', 'const controlConnRef = useRef<RTCDataChannel[]>([]);')

# 3. Socket code inside useEffect
# I'll replace everything between `socket.on("connect", () => {` and `return () => {`
start_socket = text.index('    socket.on("connect", () => {')
end_socket = text.index('    return () => {\n      socket.disconnect();')

socket_replacement = """    socket.on("connect", () => {
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

"""
text = text[:start_socket] + socket_replacement + text[end_socket:]

# Update the cleanup block inside useEffect
cleanup_target = """      if (peerRef.current) {
        peerRef.current.destroy();
      }"""
cleanup_repl = """      if (pcRef.current) {
        pcRef.current.close();
      }"""
text = text.replace(cleanup_target, cleanup_repl)

# 4. Replacement of initPeer / connectToPeer / createTransferEngine / setupConnection
webrtc_start = text.index('  const initPeer = (myId: string, roomToJoin: string) => {')
# end right before `  const handleJoin = () => {`
webrtc_end = text.index('  const handleJoin = () => {')

webrtc_replacement = """  const resetWebRTCConnection = useCallback(() => {
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

"""
text = text[:webrtc_start] + webrtc_replacement + text[webrtc_end:]

# Update handleJoin
join_target = """  const handleJoin = () => {
    if (roomCode.length === 4 && socketRef.current?.id) {
      if (peerRef.current && peerRef.current.destroyed) {
        peerRef.current = null;
      }
      // Initialize peer first, it will emit "join-room" once it's "open"
      initPeer(socketRef.current.id, roomCode);
    }
  };"""

join_repl = """  const handleJoin = () => {
    if (roomCode.length === 4 && socketRef.current) {
       console.log("Joining room:", roomCode);
       socketRef.current.emit("join-room", roomCode);
    }
  };"""
text = text.replace(join_target, join_repl)

# Update the manual socket connect handling from lines 675
# wait, there's `useEffect(() => {\n    if (isSocketConnected && joinedRef.current...`
effect_target = """  useEffect(() => {
    if (isSocketConnected && joinedRef.current && roomCodeRef.current && socketRef.current?.id) {
      console.log("Socket reconnected, re-initializing PeerJS and rejoining room...");
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
      initPeer(socketRef.current.id, roomCodeRef.current);
      
      // Warm up MediaPipe again in case WASM context was lost
      warmUpMediaPipe();
    }
  }, [isSocketConnected, warmUpMediaPipe]);"""

# we effectively deleted initPeer. The `socket.on('connect')` inside the other useEffect already emits "join-room", so this standalone effect is mostly redundant and will raise an error 'initPeer is not defined'. So we can just remove it, or adapt it.
effect_repl = """  useEffect(() => {
    if (isSocketConnected && joinedRef.current && roomCodeRef.current && socketRef.current) {
      console.log("Socket reconnected, warm up MediaPipe again");
      warmUpMediaPipe();
    }
  }, [isSocketConnected, warmUpMediaPipe]);"""

text = text.replace(effect_target, effect_repl)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Patching complete.")
