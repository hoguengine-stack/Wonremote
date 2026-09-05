import type {
  AgentConnectionInput,
  AgentFirstRunInput,
  AgentFirstRunResult,
  AgentHeartbeatInput,
  AgentHeartbeatResult,
  AgentRegistrationResult,
  DeviceGroup,
  DeviceMetadataUpdateInput,
  DeviceMetadataUpdateResult,
  ManagedDevice,
} from "./types";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "./deviceDefaults";
import { DEFAULT_DEVICE_TYPE, isGeneratedAgentDeviceName } from "./deviceType";
import { sanitizeDeviceSystemInfo } from "./deviceSystemInfo";
import { normalizeDevicePlatform } from "./devicePlatform";

export const DEVICE_CONTACT_NAME_MAX_LENGTH = 100;
export const DEVICE_INSTALL_LOCATION_MAX_LENGTH = 255;
export const DEVICE_TAG_MAX_LENGTH = 50;
export const DEVICE_TAG_MAX_COUNT = 20;
export const DEVICE_NOTES_MAX_LENGTH = 2_000;

export function authenticateAdmin(username: string, password: string): boolean {
  return username.trim() === "admin" && password === "admin1234";
}

export function normalizeBusinessNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new Error("사업자번호는 숫자 10자리여야 합니다.");
  }

  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function registerAgentConnection(
  devices: ManagedDevice[],
  input: AgentConnectionInput,
  nowIso = new Date().toISOString(),
): AgentRegistrationResult {
  const businessNumber = normalizeBusinessNumber(input.businessNumber);
  const cleaned = {
    businessNumber,
    password: input.password.trim(),
    storeName: input.storeName.trim(),
    deviceNumber: input.deviceNumber.trim(),
    deviceName: input.deviceName.trim(),
  };

  validateAgentInput(cleaned);

  const id = `${cleaned.businessNumber}:${cleaned.deviceNumber}`;
  const existing = devices.find((item) => item.id === id);
  const normalizedInputStoreName = normalizeStoreNameForDisplay(cleaned.storeName, cleaned.businessNumber);
  let finalStoreName = normalizedInputStoreName;
  let finalStoreNameSource = normalizedInputStoreName === DEFAULT_STORE_NAME ? "default" : "user";

  if (existing) {
    const existingStore = existing.storeName?.trim();
    if (existingStore) {
      const isLegacyGenerated = normalizeStoreNameForDisplay(existingStore, cleaned.businessNumber) === DEFAULT_STORE_NAME;
      const isUserSet = !isLegacyGenerated && (existing.storeNameSource === "user" || !existing.storeNameSource);
      if (isUserSet) {
        finalStoreName = existingStore;
        finalStoreNameSource = "user";
      }
    }
  }

  const device: ManagedDevice = {
    id,
    businessNumber: cleaned.businessNumber,
    storeName: finalStoreName,
    storeNameSource: finalStoreNameSource,
    deviceNumber: cleaned.deviceNumber,
    deviceName: cleaned.deviceName,
    desktopName: input.desktopName?.trim().slice(0, 255)
      || buildDesktopName(cleaned.businessNumber, cleaned.deviceNumber),
    platform: normalizeDevicePlatform(input.platform),
    status: "online",
    lastSeenAt: nowIso,
    connectionCode: generateConnectionCode(),
    version: input.version,
    ...sanitizeExistingDeviceOperationalMetadata(existing),
  };

  const index = devices.findIndex((item) => item.id === id);
  const nextDevices =
    index === -1
      ? [...devices, device]
      : devices.map((item, itemIndex) => (itemIndex === index ? device : item));

  return {
    devices: sortDevices(nextDevices),
    session: {
      id: `session-${id}`,
      deviceId: id,
      state: "connected",
      startedAt: nowIso,
    },
  };
}

export function registerAgentFirstRun(
  devices: ManagedDevice[],
  input: AgentFirstRunInput,
  nowIso = new Date().toISOString(),
): AgentFirstRunResult {
  const businessNumber = normalizeBusinessNumber(input.businessNumber);
  const password = input.password.trim();
  validateAgentPassword(password);

  const deviceNumber = buildFirstRunDeviceNumber(input.installId);
  const deviceId = `${businessNumber}:${deviceNumber}`;
  const existingDevice = devices.find((device) => device.id === deviceId);
  const derivedInput: AgentConnectionInput = {
    businessNumber,
    password,
    storeName: DEFAULT_STORE_NAME,
    deviceNumber,
    deviceName: DEFAULT_DEVICE_TYPE,
    desktopName: input.desktopName,
    platform: input.platform,
    version: input.version,
  };
  const result = registerAgentConnection(devices, derivedInput, nowIso);
  const registeredDevice = result.devices.find((item) => item.id === result.session.deviceId);
  if (!registeredDevice) {
    throw new Error("Agent 장비 등록 결과를 확인할 수 없습니다.");
  }
  const device: ManagedDevice = {
    ...registeredDevice,
    protocolVersion: sanitizeProtocolVersion(input.protocolVersion) ?? existingDevice?.protocolVersion,
    platform: normalizeDevicePlatform(input.platform ?? existingDevice?.platform),
    deviceName:
      existingDevice?.deviceName?.trim() && !isGeneratedAgentDeviceName(existingDevice.deviceName)
        ? existingDevice.deviceName.trim()
        : registeredDevice.deviceName,
    desktopName:
      !input.desktopName?.trim() && existingDevice?.desktopName?.trim()
        ? existingDevice.desktopName.trim()
        : registeredDevice.desktopName,
  };
  const nextDevices = result.devices.map((item) => (item.id === device.id ? device : item));

  return {
    devices: nextDevices,
    device,
  };
}

export function applyAgentHeartbeat(
  devices: ManagedDevice[],
  input: AgentHeartbeatInput,
  nowIso = new Date().toISOString(),
): AgentHeartbeatResult {
  const deviceId = input.deviceId.trim();
  const installId = input.installId.trim();
  if (!deviceId) {
    throw new Error("Agent 장비 ID가 비어 있습니다.");
  }
  if (!installId) {
    throw new Error("Agent 설치 식별자가 비어 있습니다.");
  }

  const index = devices.findIndex((device) => device.id === deviceId);
  if (index === -1) {
    throw new Error("Agent 장비를 찾을 수 없습니다.");
  }

  const expectedDeviceNumber = buildFirstRunDeviceNumber(installId);
  const currentDevice = devices[index];
  if (currentDevice.deviceNumber !== expectedDeviceNumber) {
    throw new Error("Agent 설치 식별자가 일치하지 않습니다.");
  }

  const normalizedStoreName = normalizeStoreNameForDisplay(currentDevice.storeName, currentDevice.businessNumber);
  const reportedDesktopName = input.desktopName?.trim().slice(0, 255);
  const shouldCorrectStoreName =
    normalizedStoreName === DEFAULT_STORE_NAME && currentDevice.storeName !== DEFAULT_STORE_NAME;
  const device: ManagedDevice = {
    ...currentDevice,
    storeName: shouldCorrectStoreName ? normalizedStoreName : currentDevice.storeName,
    ...(input.presenceMode === "manual" ? { presenceMode: "manual" as const } : {}),
    ...(typeof input.heartbeatRequestId === "string" ? { heartbeatRequestId: input.heartbeatRequestId.slice(0, 100) } : {}),
    storeNameSource: shouldCorrectStoreName ? "default" : currentDevice.storeNameSource,
    lastSeenAt: nowIso,
    status: "online",
    connectionCode: currentDevice.connectionCode ?? generateConnectionCode(),
    desktopName: reportedDesktopName || currentDevice.desktopName,
    protocolVersion: sanitizeProtocolVersion(input.protocolVersion) ?? currentDevice.protocolVersion,
    platform: normalizeDevicePlatform(input.platform ?? currentDevice.platform),
    version: input.version ?? currentDevice.version,
    displays: sanitizeDisplays(input.displays) ?? currentDevice.displays,
    activeDisplayIndex:
      typeof input.activeDisplayIndex === "number"
        ? Math.max(0, Math.trunc(input.activeDisplayIndex))
        : currentDevice.activeDisplayIndex,
    macAddresses: sanitizeMacAddresses(input.macAddresses) ?? currentDevice.macAddresses,
    systemInfo: sanitizeDeviceSystemInfo(input.systemInfo) ?? currentDevice.systemInfo,
    controlDiagnostics: sanitizeControlDiagnostics(input.controlDiagnostics) ?? currentDevice.controlDiagnostics,
    streamDiagnostics: sanitizeStreamDiagnostics(input.streamDiagnostics) ?? currentDevice.streamDiagnostics,
  };
  const nextDevices = devices.map((item, itemIndex) => (itemIndex === index ? device : item));

  return {
    devices: sortDevices(nextDevices),
    device,
  };
}

function sanitizeProtocolVersion(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function verifyAgentInstall(
  devices: ManagedDevice[],
  deviceId: string,
  installId: string,
): ManagedDevice {
  const cleanedDeviceId = deviceId.trim();
  const cleanedInstallId = installId.trim();
  if (!cleanedDeviceId) {
    throw new Error("Agent 장비 ID가 비어 있습니다.");
  }
  if (!cleanedInstallId) {
    throw new Error("Agent 설치 식별자가 비어 있습니다.");
  }

  const device = devices.find((item) => item.id === cleanedDeviceId);
  if (!device) {
    throw new Error("Agent 장비를 찾을 수 없습니다.");
  }

  const expectedDeviceNumber = buildFirstRunDeviceNumber(cleanedInstallId);
  if (device.deviceNumber !== expectedDeviceNumber) {
    throw new Error("Agent 설치 식별자가 일치하지 않습니다.");
  }

  return device;
}

export function resolveDeviceStatuses(
  devices: ManagedDevice[],
  nowIso = new Date().toISOString(),
  offlineAfterMs = 30_000,
): ManagedDevice[] {
  const nowTime = Date.parse(nowIso);
  return sortDevices(
    devices.map((device) => {
      const lastSeenTime = Date.parse(device.lastSeenAt);
      const isStale =
        Number.isFinite(nowTime) &&
        Number.isFinite(lastSeenTime) &&
        nowTime - lastSeenTime > offlineAfterMs;
      return {
        ...device,
        status: isStale && device.presenceMode !== "manual" ? "offline" : device.status,
      };
    }),
  );
}

export function updateDeviceMetadata(
  devices: ManagedDevice[],
  input: DeviceMetadataUpdateInput,
): DeviceMetadataUpdateResult {
  const deviceId = input.deviceId.trim();
  if (!deviceId) {
    throw new Error("Device id is required.");
  }

  const index = devices.findIndex((device) => device.id === deviceId);
  if (index === -1) {
    throw new Error("Device not found.");
  }

  const currentDevice = devices[index];
  const hasStoreNameInput = typeof input.storeName === "string" && input.storeName.trim();
  const normalizedInputStoreName = hasStoreNameInput
    ? normalizeStoreNameForDisplay(input.storeName, currentDevice.businessNumber)
    : currentDevice.storeName;
  const nextStoreName = normalizedInputStoreName;
  const nextStoreNameSource = hasStoreNameInput
    ? normalizedInputStoreName === DEFAULT_STORE_NAME
      ? "default"
      : "user"
    : currentDevice.storeNameSource;
  const nextDeviceName =
    typeof input.deviceName === "string" && input.deviceName.trim()
      ? input.deviceName.trim()
      : currentDevice.deviceName;
  const nextDesktopName =
    typeof input.desktopName === "string" && input.desktopName.trim()
      ? input.desktopName.trim()
      : currentDevice.desktopName;

  const device: ManagedDevice = {
    ...currentDevice,
    storeName: nextStoreName,
    storeNameSource: nextStoreNameSource,
    deviceName: nextDeviceName,
    desktopName: nextDesktopName,
  };
  applyOperationalMetadataUpdate(device, input);
  const nextDevices = devices.map((item, itemIndex) => (itemIndex === index ? device : item));

  return {
    devices: sortDevices(nextDevices),
    device,
  };
}

export function sanitizeDeviceOperationalMetadataText(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : undefined;
}

export function sanitizeDeviceTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const tag = sanitizeDeviceOperationalMetadataText(item, DEVICE_TAG_MAX_LENGTH);
    if (!tag) {
      continue;
    }
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
    if (tags.length >= DEVICE_TAG_MAX_COUNT) {
      break;
    }
  }
  return tags.length > 0 ? tags : undefined;
}

function sanitizeExistingDeviceOperationalMetadata(
  device: Partial<ManagedDevice> | undefined,
): Partial<Pick<ManagedDevice, "contactName" | "installLocation" | "tags" | "notes">> {
  if (!device) {
    return {};
  }
  const metadata: Partial<Pick<ManagedDevice, "contactName" | "installLocation" | "tags" | "notes">> = {};
  const contactName = sanitizeDeviceOperationalMetadataText(device.contactName, DEVICE_CONTACT_NAME_MAX_LENGTH);
  const installLocation = sanitizeDeviceOperationalMetadataText(
    device.installLocation,
    DEVICE_INSTALL_LOCATION_MAX_LENGTH,
  );
  const tags = sanitizeDeviceTags(device.tags);
  const notes = sanitizeDeviceOperationalMetadataText(device.notes, DEVICE_NOTES_MAX_LENGTH);
  if (contactName) metadata.contactName = contactName;
  if (installLocation) metadata.installLocation = installLocation;
  if (tags) metadata.tags = tags;
  if (notes) metadata.notes = notes;
  return metadata;
}

function applyOperationalMetadataUpdate(device: ManagedDevice, input: DeviceMetadataUpdateInput): void {
  applyOptionalTextUpdate(device, "contactName", input.contactName, DEVICE_CONTACT_NAME_MAX_LENGTH);
  applyOptionalTextUpdate(device, "installLocation", input.installLocation, DEVICE_INSTALL_LOCATION_MAX_LENGTH);
  applyOptionalTextUpdate(device, "notes", input.notes, DEVICE_NOTES_MAX_LENGTH);
  if (input.tags !== undefined) {
    const tags = sanitizeDeviceTags(input.tags);
    if (tags) {
      device.tags = tags;
    } else {
      delete device.tags;
    }
  }
}

function applyOptionalTextUpdate(
  device: ManagedDevice,
  key: "contactName" | "installLocation" | "notes",
  value: string | undefined,
  maxLength: number,
): void {
  if (value === undefined) {
    return;
  }
  const sanitized = sanitizeDeviceOperationalMetadataText(value, maxLength);
  if (sanitized) {
    device[key] = sanitized;
  } else {
    delete device[key];
  }
}

export function groupDevicesByStore(devices: ManagedDevice[]): DeviceGroup[] {
  const groups = new Map<string, ManagedDevice[]>();
  for (const device of sortDevices(devices)) {
    const group = groups.get(device.storeName) ?? [];
    group.push(device);
    groups.set(device.storeName, group);
  }

  return [...groups.entries()].map(([storeName, groupDevices]) => ({
    storeName,
    devices: groupDevices,
  }));
}

function validateAgentInput(input: AgentConnectionInput): void {
  validateAgentPassword(input.password);
  if (!input.storeName) {
    throw new Error("업장명을 입력해야 합니다.");
  }
  if (!input.deviceNumber) {
    throw new Error("장비 번호를 입력해야 합니다.");
  }
  if (!input.deviceName) {
    throw new Error("장비명을 입력해야 합니다.");
  }
}

function validateAgentPassword(password: string): void {
  if (!password) {
    throw new Error("Agent 비밀번호를 입력해야 합니다.");
  }
  if (password !== "1234") {
    throw new Error("Agent 비밀번호가 올바르지 않습니다.");
  }
}

function buildDesktopName(businessNumber: string, deviceNumber: string): string {
  const suffix = businessNumber.replace(/\D/g, "").slice(-5);
  return `DESKTOP-${suffix}-${deviceNumber.toUpperCase()}`;
}

function buildFirstRunDeviceNumber(installId: string): string {
  const suffix = installId
    .trim()
    .replace(/^agent[-_]?/i, "")
    .replace(/[^a-z0-9-]/gi, "")
    .toUpperCase();
  if (!suffix) {
    throw new Error("Agent 설치 식별자를 확인할 수 없습니다.");
  }
  return `AGENT-${suffix.slice(0, 16)}`;
}

export function sortDevices(devices: ManagedDevice[]): ManagedDevice[] {
  return [...devices].sort((left, right) => {
    const storeCompare = left.storeName.localeCompare(right.storeName, "ko");
    if (storeCompare !== 0) {
      return storeCompare;
    }
    return left.deviceNumber.localeCompare(right.deviceNumber, "ko");
  });
}

function sanitizeDisplays(displays: AgentHeartbeatInput["displays"]): ManagedDevice["displays"] | undefined {
  if (!Array.isArray(displays)) {
    return undefined;
  }
  return displays
    .filter((display) => Number.isFinite(display.index) && display.width > 0 && display.height > 0)
    .map((display) => ({
      index: Math.max(0, Math.trunc(display.index)),
      name: String(display.name || `Display ${display.index}`),
      ...(Number.isFinite(Number(display.x)) ? { x: Math.trunc(Number(display.x)) } : {}),
      ...(Number.isFinite(Number(display.y)) ? { y: Math.trunc(Number(display.y)) } : {}),
      width: Math.max(1, Math.trunc(display.width)),
      height: Math.max(1, Math.trunc(display.height)),
      primary: Boolean(display.primary),
    }))
    .sort((left, right) => left.index - right.index);
}

function sanitizeMacAddresses(macAddresses: AgentHeartbeatInput["macAddresses"]): string[] | undefined {
  if (!Array.isArray(macAddresses)) {
    return undefined;
  }
  const normalized = Array.from(
    new Set(
      macAddresses
        .map((value) => String(value ?? "").trim().toUpperCase().replace(/-/g, ":"))
        .filter((value) => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value))
        .filter((value) => value !== "00:00:00:00:00:00"),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeControlDiagnostics(
  diagnostics: AgentHeartbeatInput["controlDiagnostics"],
): ManagedDevice["controlDiagnostics"] | undefined {
  if (!diagnostics || typeof diagnostics !== "object") {
    return undefined;
  }
  return {
    elevated: typeof diagnostics.elevated === "boolean" ? diagnostics.elevated : undefined,
    integrityLevel:
      typeof diagnostics.integrityLevel === "string" && diagnostics.integrityLevel.trim()
        ? diagnostics.integrityLevel.trim()
        : undefined,
    win32ErrorCode:
      typeof diagnostics.win32ErrorCode === "number" && Number.isFinite(diagnostics.win32ErrorCode)
        ? Math.max(0, Math.trunc(diagnostics.win32ErrorCode))
        : undefined,
    win32ErrorMessage:
      typeof diagnostics.win32ErrorMessage === "string" && diagnostics.win32ErrorMessage.trim()
        ? diagnostics.win32ErrorMessage.trim()
        : undefined,
  };
}

function sanitizeStreamDiagnostics(
  diagnostics: AgentHeartbeatInput["streamDiagnostics"],
): ManagedDevice["streamDiagnostics"] | undefined {
  if (!diagnostics || typeof diagnostics !== "object") {
    return undefined;
  }
  const backend = diagnostics.backend === "gdi" || diagnostics.backend === "dxgi" ? diagnostics.backend : undefined;
  const transport =
    diagnostics.transport === "webrtc" ||
    diagnostics.transport === "firestore-fallback" ||
    diagnostics.transport === "local-api" ||
    diagnostics.transport === "none"
      ? diagnostics.transport
      : undefined;
  const rtcState =
    diagnostics.rtcState === "none" ||
    diagnostics.rtcState === "starting" ||
    diagnostics.rtcState === "ready" ||
    diagnostics.rtcState === "unavailable"
      ? diagnostics.rtcState
      : undefined;
  return {
    backend,
    desired: typeof diagnostics.desired === "boolean" ? diagnostics.desired : undefined,
    running: typeof diagnostics.running === "boolean" ? diagnostics.running : undefined,
    restartCount:
      typeof diagnostics.restartCount === "number" && Number.isFinite(diagnostics.restartCount)
        ? Math.max(0, Math.trunc(diagnostics.restartCount))
        : undefined,
    loopSleepMs:
      typeof diagnostics.loopSleepMs === "number" && Number.isFinite(diagnostics.loopSleepMs)
        ? Math.max(0, Math.trunc(diagnostics.loopSleepMs))
        : undefined,
    outputIndex:
      typeof diagnostics.outputIndex === "number" && Number.isFinite(diagnostics.outputIndex)
        ? Math.max(0, Math.trunc(diagnostics.outputIndex))
        : undefined,
    lastFrameAt:
      typeof diagnostics.lastFrameAt === "string" && diagnostics.lastFrameAt.trim()
        ? diagnostics.lastFrameAt.trim()
        : undefined,
    lastError:
      typeof diagnostics.lastError === "string" && diagnostics.lastError.trim()
        ? diagnostics.lastError.trim().slice(0, 500)
        : undefined,
    transport,
    rtcState,
    rtcError:
      typeof diagnostics.rtcError === "string" && diagnostics.rtcError.trim()
        ? diagnostics.rtcError.trim().slice(0, 500)
        : undefined,
  };
}

function generateConnectionCode(): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
