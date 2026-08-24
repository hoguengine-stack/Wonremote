export type DeviceStatus = "online" | "offline";

export type DeviceUpdateState =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "restarting"
  | "healthy"
  | "rollback"
  | "failed";

export type DeviceUpdateRing = "canary" | "pilot" | "general";

export interface AgentUpdateTelemetry {
  state: DeviceUpdateState;
  currentVersion: string;
  targetVersion?: string;
  progress?: number;
  error?: string;
  updatedAt: string;
}

export interface ManagedDevice {
  id: string;
  businessNumber: string;
  storeName: string;
  storeNameSource?: string;
  deviceNumber: string;
  deviceName: string;
  desktopName: string;
  status: DeviceStatus;
  lastSeenAt: string;
  connectionCode?: string;
  version?: string;
  displays?: DeviceDisplayInfo[];
  activeDisplayIndex?: number;
  macAddresses?: string[];
  controlDiagnostics?: AgentControlDiagnostics;
  streamDiagnostics?: AgentStreamDiagnostics;
  updateState?: DeviceUpdateState;
  updateTargetVersion?: string;
  updateCurrentVersion?: string;
  updateProgress?: number;
  updateError?: string;
  updateUpdatedAt?: string;
  updateRing?: DeviceUpdateRing;
  updatePaused?: boolean;
}

export interface AgentControlDiagnostics {
  elevated?: boolean;
  integrityLevel?: string;
  win32ErrorCode?: number;
  win32ErrorMessage?: string;
}

export interface AgentStreamDiagnostics {
  backend?: "dxgi" | "gdi";
  desired?: boolean;
  running?: boolean;
  restartCount?: number;
  loopSleepMs?: number;
  outputIndex?: number;
  lastFrameAt?: string;
  lastError?: string;
  transport?: "webrtc" | "firestore-fallback" | "local-api" | "none";
  rtcState?: "none" | "starting" | "ready" | "unavailable";
  rtcError?: string;
  backpressured?: boolean;
  bufferedAmount?: number;
  droppedFrameCount?: number;
}

export interface DeviceDisplayInfo {
  index: number;
  name: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface AgentConnectionInput {
  businessNumber: string;
  password: string;
  storeName: string;
  deviceNumber: string;
  deviceName: string;
  desktopName?: string;
  version?: string;
}

export interface AgentFirstRunInput {
  businessNumber: string;
  password: string;
  installId: string;
  desktopName?: string;
  previousDeviceId?: string;
  version?: string;
}

export interface AgentHeartbeatInput {
  deviceId: string;
  installId: string;
  desktopName?: string;
  version?: string;
  displays?: DeviceDisplayInfo[];
  activeDisplayIndex?: number;
  macAddresses?: string[];
  controlDiagnostics?: AgentControlDiagnostics;
  streamDiagnostics?: AgentStreamDiagnostics;
  updateTelemetry?: AgentUpdateTelemetry;
}

export interface AgentCommand {
  id: string;
  action: string;
  createdAt: string;
  deviceId: string;
  sessionId?: string;
}

export interface AgentCommandPollInput {
  deviceId: string;
  installId: string;
}

export interface DeviceMetadataUpdateInput {
  deviceId: string;
  businessNumber?: string;
  storeName?: string;
  deviceName?: string;
  desktopName?: string;
}

export interface DeviceMetadataUpdateResult {
  devices: ManagedDevice[];
  device: ManagedDevice;
}

export interface RemoteSession {
  id: string;
  deviceId: string;
  state: "pending" | "connected";
  startedAt: string;
}

export interface AgentRegistrationResult {
  devices: ManagedDevice[];
  session: RemoteSession;
}

export interface AgentFirstRunResult {
  devices: ManagedDevice[];
  device: ManagedDevice;
}

export interface AgentHeartbeatResult {
  devices: ManagedDevice[];
  device: ManagedDevice;
}

export interface AgentCommandPollResult {
  commands: AgentCommand[];
}

export interface DeviceGroup {
  storeName: string;
  devices: ManagedDevice[];
}

export interface ChatMessage {
  id: string;
  message: string;
  sender: "viewer" | "agent";
  createdAt: string;
}

export interface ClipboardData {
  text: string;
  sender: "viewer" | "agent";
}

export interface TransferredFile {
  id: string;
  filename: string;
  fileData: string;
  transferId?: string;
  chunkIndex?: number;
  totalChunks?: number;
  totalBytes?: number;
  isLast?: boolean;
  chunkSha256?: string;
  fileSha256?: string;
  delivery?: "firestore-direct" | "firebase-storage";
  storagePath?: string;
  purpose?: "file" | "clipboard-image";
  mimeType?: string;
}

export interface FileTransferReceipt {
  transferId: string;
  filename: string;
  status: "partial" | "received" | "failed";
  receivedChunks: number;
  totalChunks: number;
  receivedBytes?: number;
  savedPath?: string;
  error?: string;
  updatedAt: string;
}

export interface ConnectionHistoryEntry {
  id: string;
  deviceId: string;
  storeName: string;
  deviceName: string;
  startedAt: string;
  endedAt?: string;
  status: "success" | "rejected" | "closed";
}
