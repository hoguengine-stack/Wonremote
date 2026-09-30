import type { ManagedDevice } from "./types";

export const PRESENCE_REFRESH_TIMEOUT_MS = 5_000;

export function collectDevicePresence(
  devices: ManagedDevice[], requestId: string,
  subscribe: (next: (device: ManagedDevice) => void, fail: (error: unknown) => void) => () => void,
  send: (device: ManagedDevice, action: string) => Promise<unknown>,
  signal?: AbortSignal,
  onProgress?: (devices: ManagedDevice[], pendingIds: string[]) => void,
  loadDevices?: Promise<ManagedDevice[]>,
): Promise<ManagedDevice[]> {
  const targets = devices.filter((device) => device.presenceMode === "manual");
  if (!targets.length && !loadDevices) {
    if (!signal?.aborted) onProgress?.(devices, []);
    return Promise.resolve(devices);
  }
  return new Promise((resolve, reject) => {
    let currentDevices = devices;
    let loaded = !loadDevices;
    const pending = new Set<string>();
    const requested = new Set<string>();
    const expired = new Set<string>();
    const replies = new Map<string, ManagedDevice>();
    const errors = new Map<string, unknown>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let active = true;
    let stop = () => {};
    const result = () => currentDevices.map((device) => replies.get(device.id)
      ?? (expired.has(device.id) ? { ...device, status: "offline" as const } : device));
    const publish = () => onProgress?.(result(), [...pending]);
    const finish = (error?: unknown) => {
      if (!active) return;
      active = false;
      timers.forEach(clearTimeout); timers.clear();
      stop(); signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result());
    };
    const settle = () => { if (loaded && !pending.size) finish(); };
    const addTargets = (items: ManagedDevice[]) => items.filter((device) => {
      if (device.presenceMode !== "manual" || requested.has(device.id)) return false;
      requested.add(device.id); pending.add(device.id);
      timers.set(device.id, setTimeout(() => {
        if (!active) return;
        timers.delete(device.id); pending.delete(device.id); expired.add(device.id);
        publish(); settle();
      }, PRESENCE_REFRESH_TIMEOUT_MS));
      return true;
    });
    const sendTargets = (items: ManagedDevice[]) => {
      for (const device of items) {
        if (!active) break;
        void send(device, `refresh-status ${requestId}`).catch((error) => {
          if (!active) return;
          if (loaded) {
            if (currentDevices.some((item) => item.id === device.id)) finish(error);
          } else errors.set(device.id, error);
        });
      }
    };
    const abort = () => finish(new Error("Presence refresh cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    // The fresh list is authoritative; early checks never resurrect removed rows.
    void loadDevices?.then((fresh) => {
      if (!active) return;
      loaded = true; currentDevices = fresh;
      const manual = new Map(fresh.filter((device) => device.presenceMode === "manual").map((device) => [device.id, device]));
      for (const id of pending) {
        if (manual.has(id)) continue;
        clearTimeout(timers.get(id)); timers.delete(id); pending.delete(id);
      }
      for (const id of expired) { if (!manual.has(id)) expired.delete(id); }
      for (const [id, reply] of replies) {
        const device = manual.get(id);
        if (!device) replies.delete(id);
        else replies.set(id, { ...device, status: reply.status, lastSeenAt: reply.lastSeenAt, heartbeatRequestId: reply.heartbeatRequestId });
      }
      for (const [id, error] of errors) { if (manual.has(id)) { finish(error); return; } }
      const added = addTargets(fresh);
      publish(); sendTargets(added); settle();
    }).catch(finish);
    if (signal?.aborted) { abort(); return; }
    try {
      const initial = addTargets(targets);
      publish();
      stop = subscribe((device) => {
        if (!active || !pending.has(device.id) || device.heartbeatRequestId !== requestId) return;
        clearTimeout(timers.get(device.id)); timers.delete(device.id);
        replies.set(device.id, device); pending.delete(device.id);
        publish(); settle();
      }, finish);
      if (!active) { stop(); return; }
      sendTargets(initial);
    } catch (error) { finish(error); }
  });
}
