import type { ManagedDevice } from "./types";

export const PRESENCE_REFRESH_TIMEOUT_MS = 5_000;

export function collectDevicePresence(
  devices: ManagedDevice[], requestId: string,
  subscribe: (next: (device: ManagedDevice) => void, fail: (error: unknown) => void) => () => void,
  send: (device: ManagedDevice, action: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<ManagedDevice[]> {
  const targets = devices.filter((device) => device.presenceMode === "manual");
  if (!targets.length) return Promise.resolve(devices);
  return new Promise((resolve, reject) => {
    const pending = new Set(targets.map((device) => device.id));
    const replies = new Map<string, ManagedDevice>();
    let active = true;
    let stop = () => {};
    const finish = (error?: unknown) => {
      if (!active) return;
      active = false;
      clearTimeout(timer); stop(); signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(devices.map((device) => replies.get(device.id) ?? (pending.has(device.id) ? { ...device, status: "offline" } : device)));
    };
    const abort = () => finish(new Error("Presence refresh cancelled."));
    const timer = setTimeout(() => finish(), PRESENCE_REFRESH_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      stop = subscribe((device) => {
        if (!active || !pending.has(device.id) || device.heartbeatRequestId !== requestId) return;
        replies.set(device.id, device); pending.delete(device.id);
        if (!pending.size) finish();
      }, finish);
      if (!active) { stop(); return; }
      for (const device of targets) {
        if (!active) break;
        void send(device, `refresh-status ${requestId}`).catch(finish);
      }
    } catch (error) { finish(error); }
  });
}
