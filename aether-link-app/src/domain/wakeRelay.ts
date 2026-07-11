import type { ManagedDevice } from "./types";

export function normalizeWakeMac(value: string): string | null {
  const compact = value.trim().replace(/[:-]/g, "").toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(compact) || compact === "000000000000" || compact === "FFFFFFFFFFFF") {
    return null;
  }
  return compact.match(/.{2}/g)?.join(":") ?? null;
}

export function selectViewerWakeRelay(
  devices: ManagedDevice[],
  input: { businessNumber: string; nowMs: number; targetDeviceId: string; ttlMs?: number },
): ManagedDevice | null {
  const ttlMs = input.ttlMs ?? 60_000;
  return devices
    .filter((device) => {
      const lastSeenAtMs = Date.parse(device.lastSeenAt);
      return (
        device.id !== input.targetDeviceId &&
        device.businessNumber === input.businessNumber &&
        device.status === "online" &&
        Number.isFinite(lastSeenAtMs) &&
        input.nowMs - lastSeenAtMs <= ttlMs
      );
    })
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0] ?? null;
}
