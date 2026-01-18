export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
  NONE = 'NONE'
}

export enum AppState {
  DESKTOP = 'DESKTOP', // Idle desktop state
  INSTALLER_RUNNING = 'INSTALLER_RUNNING',
  ADMIN_RUNNING = 'ADMIN_RUNNING',
  AGENT_RUNNING = 'AGENT_RUNNING'
}

export interface Device {
  id: string;
  desktopName: string;
  businessId: string;
  deviceName: string;
  allowRemote: 'YES' | 'NO';
  status: 'ONLINE' | 'OFFLINE' | 'BLOCKED';
  socketId?: string;
  lastSeen?: string;
  groupName?: string;
  installedAt?: string;
  os?: string;
  memo?: string;
  ipAddress?: string;
  width?: number;  // Screen Width
  height?: number; // Screen Height
  displays?: DisplayInfo[];
  activeDisplayId?: number;
  name?: string;
  logs?: string[];
}

export interface DisplayInfo {
  id: number;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number }; // DIP
  scaleFactor: number; // DPI 배율
}

export interface FileNode {
  name: string;
  type: 'file' | 'folder';
  size?: string;
  date?: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: Date;
}
