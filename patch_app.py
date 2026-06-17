import sys

with open('src/App.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_content = []
for idx, line in enumerate(lines):
    if idx >= 1563 and line.strip() == 'return (':
        break
    new_content.append(line)

bridge_hooks = """  // --- PHASE 4 BRIDGE HOOKS ---
  useEffect(() => {
    if (isSocketConnected) (window as any).Signaling?.onConnect();
    else (window as any).Signaling?.onDisconnect();
  }, [isSocketConnected]);

  useEffect(() => {
    if (joined && roomCode) {
      (window as any).Signaling?.setRoomCode(roomCode);
      (window as any).transitionToSender?.(roomCode);
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
    (window as any).updateGrabButtonState?.(hasFiles, isGlobalLocked, isSource !== null ? isSource : null);
    (window as any).updateDropButtonState?.(!!incomingFile, isGlobalLocked, isSource !== null ? isSource : null);
  }, [selectedFiles, isGlobalLocked, isSource, incomingFile]);

  useEffect(() => {
    if (isTransferring && isSource) {
      (window as any).ParticleSystem?.startTransfer(
        () => transferProgress,
        () => telemetry?.speedMBps ?? 0
      );
    }
    if (isTransferring && !isSource) {
        (window as any).updateReceiverProgress?.(transferProgress, telemetry?.speedMBps ?? 0);
    }
  }, [isTransferring, isSource, transferProgress, telemetry]);

  useEffect(() => {
    if (cameraError) (window as any).showCameraDeniedBanner?.();
  }, [cameraError]);

  useEffect(() => {
    document.getElementById('btn-join')?.addEventListener('click', () => {
      const code = [0,1,2,3].map(i =>
        (document.getElementById(`otp-${i}`) as HTMLInputElement)?.value || ''
      ).join('');
      if (code.length === 4) {
        setRoomCode(code);
        socketRef.current?.emit('join-room', code);
      }
    });

    document.getElementById('btn-create')?.addEventListener('click', () => {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      setRoomCode(code);
      code.split('').forEach((d, i) => {
        const box = document.getElementById(`otp-${i}`) as HTMLInputElement;
        if (box) box.value = d;
      });
      (window as any).generateQRFromCode?.(code);
      socketRef.current?.emit('join-room', code);
    });

    document.getElementById('btn-grab')?.addEventListener('click', () => {
      handleGrabAction();
      socketRef.current?.emit('grabbed', roomCodeRef.current);
    });

    document.getElementById('btn-drop')?.addEventListener('click', () => {
      handleDropAction();
    });

    document.getElementById('file-input')?.addEventListener('change', (e) => {
      const files = Array.from((e.target as HTMLInputElement).files || []);
      setSelectedFiles(files);
      selectedFilesRef.current = files;
    });

    document.getElementById('btn-cancel')?.addEventListener('click', cancelTransfer);

    document.getElementById('btn-leave')?.addEventListener('click', () => {
      socketRef.current?.emit('dropped', roomCodeRef.current);
      socketRef.current?.emit('leave-room');
      setJoined(false);
      setConnected(false);
      setSelectedFiles([]);
      setRoomCode('');
      (window as any).leaveRoom?.();
    });

    document.getElementById('btn-download-main')?.addEventListener('click', () => {
      // patched by HTML logic when file received
    });

    document.getElementById('btn-rx-leave')?.addEventListener('click', () => {
      (window as any).leaveReceiver?.();
    });

    document.getElementById('btn-error-retry')?.addEventListener('click', () => {
      cancelTransfer();
    });

    (window as any)._completeTransferCh3 = () => {
      // Success screen is handled by Ch3
    };

    (window as any)._socketLeaveRoom = () => {
      socketRef.current?.emit('leave-room');
      setJoined(false);
      setConnected(false);
      setSelectedFiles([]);
      setRoomCode('');
    };

    (window as any)._socketCancelTransfer = () => {
      cancelTransfer();
    };

    (window as any).updateGrabButtonState = (hasFiles: boolean, isLocked: boolean, isSource: boolean | null) => {
      const btn = document.getElementById('btn-grab') as HTMLButtonElement;
      if (!btn) return;
      btn.disabled = !hasFiles || isLocked;
    };

    (window as any).updateDropButtonState = (hasIncoming: boolean, isLocked: boolean, isSource: boolean | null) => {
      const btn = document.getElementById('btn-drop') as HTMLButtonElement;
      if (!btn) return;
      btn.disabled = !(isLocked && hasIncoming && isSource === null);
    };

  }, []);

  return (
    <div style={{ display: "none", position: "fixed", top: 0, left: 0, zIndex: -1 }} aria-hidden="true">
      <video ref={videoRef} playsInline muted style={{ width: 320, height: 240 }} />
      <canvas ref={canvasRef} width={320} height={240} />
    </div>
  );
}

export default App;
"""

new_content.append(bridge_hooks)

with open('src/App.tsx', 'w', encoding='utf-8') as f:
    f.writelines(new_content)

print('App.tsx patched successfully.')
