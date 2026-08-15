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
    __nexusCurrentScreen?: 'home' | 'sender' | 'receiver';
    resetSenderUI?: () => void;
    _ch8CleanUp?: () => void;
    updateGrabButtonState?: (hasFiles: boolean, isGlobalLocked: boolean, isSource: boolean) => void;
    showSenderProgress?: (file?: File, batchIndex?: number, batchCount?: number) => void;
    showReceiverProgress?: (filename: string, totalBytes: number, batchIndex?: number, batchCount?: number) => void;
    updateSenderProgress?: (progress: number, speedMbps: number, batchIndex?: number, batchCount?: number) => void;
    updateReceiverProgress?: (progress: number, speedMbps: number) => void;
    setTransferPhase?: (phase: 'idle' | 'requested' | 'active' | 'stalled') => void;
    getTransferPhase?: () => 'idle' | 'requested' | 'active' | 'stalled';
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
    Toast?: {
      show: (message: string, type?: 'info' | 'success' | 'warning' | 'error', duration?: number, options?: { actionText?: string; onAction?: (toast: any) => void }) => any;
      dismiss?: (toast: any) => void;
      dismissAll?: () => void;
    };
    retrySignaling?: () => void;
    __SERVER_LOCAL_IP__?: string;
    updateQR?: () => void;
    ParticleSystem?: {
      startTransfer?: (progressGetter: () => number, speedGetter: () => number) => void;
    };
  }
}
