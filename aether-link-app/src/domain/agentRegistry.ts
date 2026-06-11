import type {
  AgentConnectionInput,
  AgentFirstRunInput,
  AgentFirstRunResult,
  AgentHeartbeatInput,
  AgentHeartbeatResult,
  AgentRegistrationResult,
  DeviceGroup,
  ManagedDevice,
} from "./types";

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
  const device: ManagedDevice = {
    id,
    businessNumber: cleaned.businessNumber,
    storeName: cleaned.storeName,
    deviceNumber: cleaned.deviceNumber,
    deviceName: cleaned.deviceName,
    desktopName: buildDesktopName(cleaned.businessNumber, cleaned.deviceNumber),
    status: "online",
    lastSeenAt: nowIso,
    connectionCode: generateConnectionCode(),
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
  const derivedInput: AgentConnectionInput = {
    businessNumber,
    password,
    storeName: `사업자 ${businessNumber}`,
    deviceNumber,
    deviceName: `Agent ${deviceNumber}`,
  };
  const result = registerAgentConnection(devices, derivedInput, nowIso);
  const device = result.devices.find((item) => item.id === result.session.deviceId);
  if (!device) {
    throw new Error("Agent 장비 등록 결과를 확인할 수 없습니다.");
  }

  return {
    devices: result.devices,
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

  const device: ManagedDevice = {
    ...currentDevice,
    lastSeenAt: nowIso,
    status: "online",
    connectionCode: currentDevice.connectionCode ?? generateConnectionCode(),
  };
  const nextDevices = devices.map((item, itemIndex) => (itemIndex === index ? device : item));

  return {
    devices: sortDevices(nextDevices),
    device,
  };
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
        status: isStale ? "offline" : device.status,
      };
    }),
  );
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

function sortDevices(devices: ManagedDevice[]): ManagedDevice[] {
  return [...devices].sort((left, right) => {
    const storeCompare = left.storeName.localeCompare(right.storeName, "ko");
    if (storeCompare !== 0) {
      return storeCompare;
    }
    return left.deviceNumber.localeCompare(right.deviceNumber, "ko");
  });
}

function generateConnectionCode(): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
