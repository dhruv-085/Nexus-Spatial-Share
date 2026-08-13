export {};

declare global {
  interface Window {
    Buffer: any;
    process: any;
    Signaling?: {
      onConnect?: () => void;
      onDisconnect?: () => void;
      onPeerJoined?: (role: string) => void;
      onPeerLeft?: (midTransfer?: boolean) => void;
      onWebRTCOpen?: () => void;
      onWebRTCClose?: () => void;
      setRoomCode?: (code: string) => void;
    };
    transitionToSender?: (code: string) => void;
    transitionToReceiver?: (code: string) => void;
    resetSenderUI?: () => void;
    _ch8CleanUp?: () => void;
    updateGrabButtonState?: (hasFiles: boolean, isGlobalLocked: boolean, isSource: boolean) => void;
    updateDropButtonState?: (hasIncomingFile: boolean, isGlobalLocked: boolean, isSource: boolean, isGrabbedPermanent: boolean) => void;
    updateReceiverProgress?: (progress: number, speedMbps: number) => void;
    setTransferPhase?: (phase: 'idle' | 'requested' | 'active' | 'stalled') => void;
    getTransferPhase?: () => 'idle' | 'requested' | 'active' | 'stalled';
    showCameraDeniedBanner?: () => void;
    showSignalingError?: () => void;
    _socketIsConnected?: () => boolean;
    _socketJoinRoom?: (code: string) => void;
    _socketCreateRoom?: (code: string) => void;
    onFilesSelected?: (files: File[]) => void;
    sendFilesViaWebRTC?: (files: File[]) => void;
    leaveRoom?: () => void;
    leaveReceiver?: () => void;
    _completeTransferCh3?: () => void;
    _socketLeaveRoom?: () => void;
    _socketCancelTransfer?: () => void;
    onFileReceivedSuccess?: (fileObj: { name: string; size: number; url: string | null }) => void;
    ParticleSystem?: {
      startTransfer?: (progressGetter: () => number, speedGetter: () => number) => void;
    };
  }
}
