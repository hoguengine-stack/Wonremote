import type { ManagedDevice } from "./types";

export const PRESENCE_REFRESH_TIMEOUT_MS = 5_000;

export function mergeScopedDeviceRefresh(current:ManagedDevice[], updated:ManagedDevice[], targetIds:readonly string[]):ManagedDevice[] {
  const targets=new Set(targetIds),next=new Map(updated.map(device=>[device.id,device]));
  return current.filter(device=>!targets.has(device.id)||next.has(device.id)).map(device=>targets.has(device.id)?next.get(device.id)!:device);
}

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
    const timers = new Map<ReturnType<typeof setTimeout>, Set<string>>();
    let active = true;
    let stop = () => {};
    let replyPublishQueued = false;
    const result = () => currentDevices.map((device) => replies.get(device.id)
      ?? (expired.has(device.id) ? { ...device, status: "offline" as const, presenceCheckTimedOut: true as const } : device));
    const publish = () => onProgress?.(result(), [...pending]);
    const publishReplies = () => {
      if (!onProgress || replyPublishQueued) return;
      replyPublishQueued = true;
      queueMicrotask(() => {
        if (!replyPublishQueued) return;
        replyPublishQueued = false;
        if (active) publish();
      });
    };
    const finish = (error?: unknown) => {
      if (!active) return;
      active = false;
      for (const timer of timers.keys()) clearTimeout(timer);
      timers.clear();
      stop(); signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result());
    };
    const settle = () => { if (loaded && !pending.size) finish(); };
    const removePending = (id: string) => {
      pending.delete(id);
      for (const [timer, group] of timers) {
        if (!group.delete(id)) continue;
        if (group.size === 0) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        break;
      }
    };
    const addTargets = (items: ManagedDevice[]) => {
      const added = items.filter((device) => {
        if (device.presenceMode !== "manual" || requested.has(device.id)) return false;
        requested.add(device.id); pending.add(device.id);
        return true;
      });
      if (!added.length) return added;
      const group = new Set(added.map(device => device.id));
      const timer = setTimeout(() => {
        if (!active) return;
        timers.delete(timer);
        for (const id of group) {
          pending.delete(id);
          expired.add(id);
        }
        publish(); settle();
      }, PRESENCE_REFRESH_TIMEOUT_MS);
      timers.set(timer, group);
      return added;
    };
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
        removePending(id);
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
        removePending(device.id);
        replies.set(device.id, device);
        if (loaded && !pending.size) {
          replyPublishQueued = false;
          publish(); settle();
        } else publishReplies();
      }, finish);
      if (!active) { stop(); return; }
      sendTargets(initial);
    } catch (error) { finish(error); }
  });
}
