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
  controlDiagnostics?: unknown;
  streamDiagnostics?: unknown;
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
  const device: ManagedDevice & { ownerUid: string } = {
    id: buildFirebaseDeviceId(businessNumber, input.installId),
    businessNumber,
    storeName: DEFAULT_STORE_NAME,
    deviceNumber,
    deviceName: `Agent ${deviceNumber}`,
    desktopName: buildDesktopName(businessNumber, input.installId),
    status: "online",
    lastSeenAt: input.nowIso,
    storeNameSource: "default",
    ownerUid: input.ownerUid,
  };
  if (typeof input.version === "string" && input.version.trim()) {
    device.version = input.version.trim();
  }
  return device;
}

export function mergeFirstRunDeviceDocument(
  device: ManagedDevice & { ownerUid: string },
  existing: Partial<FirestoreDeviceDocument> | undefined,
): ManagedDevice & { ownerUid: string } {
  const merged = { ...device };
  if (!existing) {
    return merged;
  }

  const existingStore = existing.storeName?.trim();
  if (existingStore) {
    const isLegacyGenerated = normalizeStoreNameForDisplay(existingStore, device.businessNumber) === DEFAULT_STORE_NAME;
    const isUserSet = !isLegacyGenerated && (existing.storeNameSource === "user" || !existing.storeNameSource);

    if (isUserSet) {
      merged.storeName = existingStore;
      merged.storeNameSource = "user";
    }
  }
  if (typeof existing.deviceName === "string" && existing.deviceName.trim()) {
    merged.deviceName = existing.deviceName.trim();
  }
  if (typeof existing.desktopName === "string" && existing.desktopName.trim()) {
    merged.desktopName = existing.desktopName.trim();
  }

  return merged;
}

export function mapFirestoreDevice(id: string, data: Partial<FirestoreDeviceDocument>): ManagedDevice {
  return {
    id,
    businessNumber: String(data.businessNumber ?? ""),
    storeName: normalizeStoreNameForDisplay(data.storeName, String(data.businessNumber ?? "")),
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
    controlDiagnostics: sanitizeControlDiagnostics(data.controlDiagnostics),
    streamDiagnostics: sanitizeStreamDiagnostics(data.streamDiagnostics),
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

function sanitizeControlDiagnostics(value: unknown): ManagedDevice["controlDiagnostics"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    elevated: typeof raw.elevated === "boolean" ? raw.elevated : undefined,
    integrityLevel: typeof raw.integrityLevel === "string" ? raw.integrityLevel : undefined,
    win32ErrorCode: typeof raw.win32ErrorCode === "number" ? raw.win32ErrorCode : undefined,
    win32ErrorMessage: typeof raw.win32ErrorMessage === "string" ? raw.win32ErrorMessage : undefined,
  };
}

function sanitizeStreamDiagnostics(value: unknown): ManagedDevice["streamDiagnostics"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const backend = raw.backend === "gdi" || raw.backend === "dxgi" ? raw.backend : undefined;
  const transport =
    raw.transport === "webrtc" ||
    raw.transport === "firestore-fallback" ||
    raw.transport === "local-api" ||
    raw.transport === "none"
      ? raw.transport
      : undefined;
  const rtcState =
    raw.rtcState === "none" ||
    raw.rtcState === "starting" ||
    raw.rtcState === "ready" ||
    raw.rtcState === "unavailable"
      ? raw.rtcState
      : undefined;
  return {
    backend,
    desired: typeof raw.desired === "boolean" ? raw.desired : undefined,
    running: typeof raw.running === "boolean" ? raw.running : undefined,
    restartCount:
      typeof raw.restartCount === "number" && Number.isFinite(raw.restartCount)
        ? Math.max(0, Math.trunc(raw.restartCount))
        : undefined,
    loopSleepMs:
      typeof raw.loopSleepMs === "number" && Number.isFinite(raw.loopSleepMs)
        ? Math.max(0, Math.trunc(raw.loopSleepMs))
        : undefined,
    outputIndex:
      typeof raw.outputIndex === "number" && Number.isFinite(raw.outputIndex)
        ? Math.max(0, Math.trunc(raw.outputIndex))
        : undefined,
    lastFrameAt:
      typeof raw.lastFrameAt === "string" && raw.lastFrameAt.trim() ? raw.lastFrameAt.trim() : undefined,
    lastError:
      typeof raw.lastError === "string" && raw.lastError.trim() ? raw.lastError.trim().slice(0, 500) : undefined,
    transport,
    rtcState,
    rtcError:
      typeof raw.rtcError === "string" && raw.rtcError.trim() ? raw.rtcError.trim().slice(0, 500) : undefined,
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
