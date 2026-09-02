import type { DeviceDisplayInfo, DeviceStatus, DeviceUpdateRing, DeviceUpdateState, ManagedDevice } from "../domain/types";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "../domain/deviceDefaults";
import { DEFAULT_DEVICE_TYPE, isGeneratedAgentDeviceName } from "../domain/deviceType";
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
  protocolVersion?: unknown;
  activeDisplayIndex?: number;
  displays?: unknown;
  macAddresses?: unknown;
  controlDiagnostics?: unknown;
  streamDiagnostics?: unknown;
  updateState?: unknown;
  updateTargetVersion?: unknown;
  updateCurrentVersion?: unknown;
  updateProgress?: unknown;
  updateError?: unknown;
  updateUpdatedAt?: unknown;
  updateRing?: unknown;
  updatePaused?: unknown;
}

interface BuildFirestoreDeviceInput {
  businessNumber: string;
  desktopName?: string;
  installId: string;
  nowIso: string;
  ownerUid: string;
  version?: string;
  protocolVersion?: number;
}

export function buildFirestoreDevice(input: BuildFirestoreDeviceInput): ManagedDevice & { ownerUid: string } {
  const businessNumber = formatBusinessNumber(input.businessNumber);
  const deviceNumber = buildAgentDeviceNumber(input.installId);
  const device: ManagedDevice & { ownerUid: string } = {
    id: buildFirebaseDeviceId(businessNumber, input.installId),
    businessNumber,
    storeName: DEFAULT_STORE_NAME,
    deviceNumber,
    deviceName: DEFAULT_DEVICE_TYPE,
    desktopName: input.desktopName?.trim().slice(0, 255)
      || buildDesktopName(businessNumber, input.installId),
    status: "online",
    lastSeenAt: input.nowIso,
    storeNameSource: "default",
    ownerUid: input.ownerUid,
  };
  if (typeof input.version === "string" && input.version.trim()) {
    device.version = input.version.trim();
  }
  if (Number.isSafeInteger(input.protocolVersion) && input.protocolVersion! >= 0) {
    device.protocolVersion = input.protocolVersion;
  }
  return device;
}

export function mergeFirstRunDeviceDocument(
  device: ManagedDevice & { ownerUid: string },
  existing: Partial<FirestoreDeviceDocument> | undefined,
  preferIncomingDesktopName = false,
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
  if (
    typeof existing.deviceName === "string"
    && existing.deviceName.trim()
    && !isGeneratedAgentDeviceName(existing.deviceName)
  ) {
    merged.deviceName = existing.deviceName.trim();
  }
  if (!preferIncomingDesktopName && typeof existing.desktopName === "string" && existing.desktopName.trim()) {
    merged.desktopName = existing.desktopName.trim();
  }
  const updateRing = sanitizeUpdateRing(existing.updateRing);
  if (updateRing) {
    merged.updateRing = updateRing;
  }
  if (typeof existing.updatePaused === "boolean") {
    merged.updatePaused = existing.updatePaused;
  }

  return merged;
}

export function mapFirestoreDevice(id: string, data: Partial<FirestoreDeviceDocument>): ManagedDevice {
  const device: ManagedDevice = {
    id,
    businessNumber: String(data.businessNumber ?? ""),
    storeName: normalizeStoreNameForDisplay(data.storeName, String(data.businessNumber ?? "")),
    deviceNumber: String(data.deviceNumber ?? ""),
    deviceName: String(data.deviceName ?? ""),
    desktopName: String(data.desktopName ?? ""),
    status: data.status === "offline" ? "offline" : "online",
    lastSeenAt: coerceTimestamp(data.lastSeenAt),
  };
  assignIfDefined(device, "storeNameSource", sanitizeOptionalString(data.storeNameSource));
  assignIfDefined(device, "connectionCode", sanitizeOptionalString(data.connectionCode));
  assignIfDefined(device, "version", sanitizeOptionalString(data.version));
  assignIfDefined(
    device,
    "protocolVersion",
    Number.isSafeInteger(Number(data.protocolVersion)) && Number(data.protocolVersion) >= 0
      ? Number(data.protocolVersion)
      : undefined,
  );
  assignIfDefined(
    device,
    "activeDisplayIndex",
    Number.isFinite(Number(data.activeDisplayIndex)) ? Number(data.activeDisplayIndex) : undefined,
  );
  assignIfDefined(device, "displays", sanitizeDisplays(data.displays));
  assignIfDefined(device, "macAddresses", sanitizeMacAddresses(data.macAddresses));
  assignIfDefined(device, "controlDiagnostics", sanitizeControlDiagnostics(data.controlDiagnostics));
  assignIfDefined(device, "streamDiagnostics", sanitizeStreamDiagnostics(data.streamDiagnostics));
  assignIfDefined(device, "updateState", sanitizeUpdateState(data.updateState));
  assignIfDefined(device, "updateTargetVersion", sanitizeOptionalString(data.updateTargetVersion));
  assignIfDefined(device, "updateCurrentVersion", sanitizeOptionalString(data.updateCurrentVersion));
  assignIfDefined(device, "updateProgress", sanitizeUpdateProgress(data.updateProgress));
  assignIfDefined(device, "updateError", sanitizeOptionalString(data.updateError, 500));
  assignIfDefined(device, "updateUpdatedAt", coerceOptionalTimestamp(data.updateUpdatedAt));
  assignIfDefined(device, "updateRing", sanitizeUpdateRing(data.updateRing));
  assignIfDefined(device, "updatePaused", typeof data.updatePaused === "boolean" ? data.updatePaused : undefined);
  return device;
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
        ...(typeof raw.x === "number" && Number.isFinite(raw.x) ? { x: raw.x } : {}),
        ...(typeof raw.y === "number" && Number.isFinite(raw.y) ? { y: raw.y } : {}),
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
    backpressured: typeof raw.backpressured === "boolean" ? raw.backpressured : undefined,
    bufferedAmount:
      typeof raw.bufferedAmount === "number" && Number.isFinite(raw.bufferedAmount)
        ? Math.max(0, Math.trunc(raw.bufferedAmount))
        : undefined,
    droppedFrameCount:
      typeof raw.droppedFrameCount === "number" && Number.isFinite(raw.droppedFrameCount)
        ? Math.max(0, Math.trunc(raw.droppedFrameCount))
        : undefined,
  };
}

function sanitizeUpdateState(value: unknown): DeviceUpdateState | undefined {
  return value === "idle" ||
    value === "checking" ||
    value === "downloading" ||
    value === "installing" ||
    value === "restarting" ||
    value === "healthy" ||
    value === "rollback" ||
    value === "failed"
    ? value
    : undefined;
}

function sanitizeUpdateRing(value: unknown): DeviceUpdateRing | undefined {
  return value === "canary" || value === "pilot" || value === "general" ? value : undefined;
}

function sanitizeUpdateProgress(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value))) : undefined;
}

function sanitizeOptionalString(value: unknown, maxLength = 200): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function coerceOptionalTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    try {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
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
