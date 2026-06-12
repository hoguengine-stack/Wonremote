export type DeviceStatus = "online" | "offline";

export interface ManagedDevice {
  id: string;
  businessNumber: string;
  storeName: string;
  deviceNumber: string;
  deviceName: string;
  desktopName: string;
  status: DeviceStatus;
  lastSeenAt: string;
  connectionCode?: string;
  version?: string;
  displays?: DeviceDisplayInfo[];
  activeDisplayIndex?: number;
}

export interface DeviceDisplayInfo {
  index: number;
  name: string;
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
  version?: string;
}

export interface AgentFirstRunInput {
  businessNumber: string;
  password: string;
  installId: string;
  version?: string;
}

export interface AgentHeartbeatInput {
  deviceId: string;
  installId: string;
  version?: string;
  displays?: DeviceDisplayInfo[];
  activeDisplayIndex?: number;
}

export interface AgentCommand {
  id: string;
  action: string;
  createdAt: string;
  deviceId: string;
}

export interface AgentCommandPollInput {
  deviceId: string;
  installId: string;
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
  isLast?: boolean;
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
