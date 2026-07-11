import type { ConnectionHistoryEntry, ManagedDevice } from "./types";

export function createFirebaseSessionId(
  deviceId: string,
  nowMs: number = Date.now(),
  randomValue: number = Math.random(),
): string {
  const safeDeviceId = deviceId.trim().replace(/[^A-Za-z0-9:_-]/g, "_");
  const nonce = Math.floor(Math.max(0, Math.min(0.999999999, randomValue)) * 0x1_0000_0000)
    .toString(36)
    .padStart(7, "0");
  return `session-${safeDeviceId}-${nowMs.toString(36)}-${nonce}`;
}

export function mapFirebaseSessionHistory(
  sessions: Array<{ id: string; data: Record<string, unknown> }>,
  devices: ManagedDevice[],
): ConnectionHistoryEntry[] {
  const devicesById = new Map(devices.map((device) => [device.id, device]));

  const history = sessions.reduce<ConnectionHistoryEntry[]>((entries, { id, data }) => {
      const deviceId = typeof data.deviceId === "string" ? data.deviceId : "";
      const device = devicesById.get(deviceId);
      const startedAt = firestoreDateToIso(data.startedAt) ?? firestoreDateToIso(data.createdAt);
      if (!deviceId || !startedAt) {
        return entries;
      }

      const endedAt = firestoreDateToIso(data.closedAt);
      entries.push({
        id,
        deviceId,
        storeName: device?.storeName ?? "삭제된 장비",
        deviceName: device?.deviceName ?? deviceId,
        startedAt,
        ...(endedAt ? { endedAt } : {}),
        status: data.state === "closed" ? "closed" : "success",
      });
      return entries;
    }, []);

  return history.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function firestoreDateToIso(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof value === "object" && value !== null && "toDate" in value) {
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === "function") {
      const date = toDate.call(value);
      if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }
  return undefined;
}
