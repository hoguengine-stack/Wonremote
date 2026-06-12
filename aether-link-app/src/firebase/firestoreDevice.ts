import type { DeviceStatus, ManagedDevice } from "../domain/types";
import {
  buildAgentDeviceNumber,
  buildDesktopName,
  buildFirebaseDeviceId,
  formatBusinessNumber,
} from "./firebaseIdentity";

export interface FirestoreDeviceDocument {
  businessNumber: string;
  connectionCode?: string;
  desktopName: string;
  deviceName: string;
  deviceNumber: string;
  lastSeenAt: string;
  ownerUid?: string;
  status: DeviceStatus;
  storeName: string;
  version?: string;
}

interface BuildFirestoreDeviceInput {
  businessNumber: string;
  installId: string;
  nowIso: string;
  ownerUid: string;
  version?: string;
}

export function buildFirestoreDevice(input: BuildFirestoreDeviceInput): ManagedDevice & { ownerUid: string } {
  const businessNumber = formatBusinessNumber(input.businessNumber);
  const deviceNumber = buildAgentDeviceNumber(input.installId);
  return {
    id: buildFirebaseDeviceId(businessNumber, input.installId),
    businessNumber,
    storeName: `사업자 ${businessNumber}`,
    deviceNumber,
    deviceName: `Agent ${deviceNumber}`,
    desktopName: buildDesktopName(businessNumber, input.installId),
    status: "online",
    lastSeenAt: input.nowIso,
    connectionCode: undefined,
    version: input.version,
    ownerUid: input.ownerUid,
  };
}

export function mapFirestoreDevice(id: string, data: Partial<FirestoreDeviceDocument>): ManagedDevice {
  return {
    id,
    businessNumber: String(data.businessNumber ?? ""),
    storeName: String(data.storeName ?? ""),
    deviceNumber: String(data.deviceNumber ?? ""),
    deviceName: String(data.deviceName ?? ""),
    desktopName: String(data.desktopName ?? ""),
    status: data.status === "offline" ? "offline" : "online",
    lastSeenAt: coerceTimestamp(data.lastSeenAt),
    connectionCode: data.connectionCode,
    version: data.version,
  };
}

function coerceTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return new Date(0).toISOString();
}
