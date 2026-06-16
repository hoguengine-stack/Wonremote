import type { DeviceDisplayInfo, DeviceStatus, ManagedDevice } from "../domain/types";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "../domain/deviceDefaults";
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
  storeNameSource?: string;
  version?: string;
  activeDisplayIndex?: number;
  displays?: unknown;
  macAddresses?: unknown;
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
    storeName: DEFAULT_STORE_NAME,
    deviceNumber,
    deviceName: `Agent ${deviceNumber}`,
    desktopName: buildDesktopName(businessNumber, input.installId),
    status: "online",
    lastSeenAt: input.nowIso,
    storeNameSource: "default",
    version: input.version,
    ownerUid: input.ownerUid,
  };
}

export function mapFirestoreDevice(id: string, data: Partial<FirestoreDeviceDocument>): ManagedDevice {
  return {
    id,
    businessNumber: String(data.businessNumber ?? ""),
    storeName: normalizeStoreNameForDisplay(data.storeName, String(data.businessNumber ?? ""), {
      preserveLegacyGeneratedName: data.storeNameSource === "user",
    }),
    deviceNumber: String(data.deviceNumber ?? ""),
    deviceName: String(data.deviceName ?? ""),
    desktopName: String(data.desktopName ?? ""),
    status: data.status === "offline" ? "offline" : "online",
    lastSeenAt: coerceTimestamp(data.lastSeenAt),
    connectionCode: data.connectionCode,
    version: data.version,
    activeDisplayIndex: Number.isFinite(Number(data.activeDisplayIndex)) ? Number(data.activeDisplayIndex) : undefined,
    displays: sanitizeDisplays(data.displays),
    macAddresses: sanitizeMacAddresses(data.macAddresses),
  };
}

function sanitizeDisplays(value: unknown): DeviceDisplayInfo[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const displays = value
    .filter((display) => display && typeof display === "object")
    .map((display) => {
      const raw = display as Partial<DeviceDisplayInfo>;
      return {
        index: Number(raw.index),
        name: String(raw.name ?? `Display ${raw.index ?? ""}`),
        width: Number(raw.width),
        height: Number(raw.height),
        primary: Boolean(raw.primary),
      };
    })
    .filter(
      (display) =>
        Number.isFinite(display.index) &&
        Number.isFinite(display.width) &&
        Number.isFinite(display.height) &&
        display.width > 0 &&
        display.height > 0,
    );
  return displays.length > 0 ? displays : undefined;
}

function sanitizeMacAddresses(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const macAddresses = Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim().toUpperCase().replace(/-/g, ":"))
        .filter((item) => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(item))
        .filter((item) => item !== "00:00:00:00:00:00"),
    ),
  );
  return macAddresses.length > 0 ? macAddresses : undefined;
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
