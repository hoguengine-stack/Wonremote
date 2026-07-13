import { resolveDeviceStatuses, sortDevices } from "./agentRegistry";
import type { ManagedDevice } from "./types";

export function prepareViewerDeviceList(
  devices: ManagedDevice[],
  nowIso = new Date().toISOString(),
  offlineAfterMs = 60_000,
): ManagedDevice[] {
  const resolved = resolveDeviceStatuses(devices, nowIso, offlineAfterMs);
  const preferredFirst = [...resolved].sort(comparePreferredRegistration);
  const seenHardware = new Set<string>();
  const visible: ManagedDevice[] = [];

  for (const device of preferredFirst) {
    const hardwareKey = buildHardwareKey(device.macAddresses);
    if (hardwareKey && seenHardware.has(hardwareKey)) {
      continue;
    }
    if (hardwareKey) {
      seenHardware.add(hardwareKey);
    }
    visible.push(device);
  }

  return sortDevices(visible);
}

export function resolveViewerOfflineAfterMs(env: object): number {
  const source = env as Record<string, unknown>;
  const configured = Number(source.VITE_WONREMOTE_AGENT_OFFLINE_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(15_000, Math.trunc(configured))
    : 60_000;
}

function buildHardwareKey(macAddresses: string[] | undefined): string | null {
  if (!macAddresses?.length) {
    return null;
  }
  const normalized = Array.from(
    new Set(
      macAddresses
        .map((value) => value.replace(/[^0-9a-f]/gi, "").toUpperCase())
        .filter((value) => value.length === 12 && value !== "000000000000"),
    ),
  ).sort();
  return normalized.length > 0 ? normalized.join("|") : null;
}

function comparePreferredRegistration(left: ManagedDevice, right: ManagedDevice): number {
  if (left.status !== right.status) {
    return left.status === "online" ? -1 : 1;
  }
  const lastSeenCompare = Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  if (Number.isFinite(lastSeenCompare) && lastSeenCompare !== 0) {
    return lastSeenCompare;
  }
  return left.id.localeCompare(right.id, "ko");
}
