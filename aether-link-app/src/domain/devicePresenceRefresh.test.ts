import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDevicePresence } from "./devicePresenceRefresh";
import { resolveDeviceStatuses } from "./agentRegistry";
import { createApiServer } from "../server/apiServer";
import type { ManagedDevice } from "./types";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw new Error("Presence refresh must not package update archives"); }),
}));

const device: ManagedDevice = {
  id: "123-45-67890:AGENT-TEST0001", businessNumber: "123-45-67890", deviceNumber: "AGENT-TEST0001",
  desktopName: "PC", deviceName: "POS", storeName: "Store", status: "online",
  lastSeenAt: "2020-01-01T00:00:00Z", presenceMode: "manual", protocolVersion: 2,
};
afterEach(() => vi.useRealTimers());

describe("on-demand Agent presence", () => {
  it("shows the list before waiting, progressively publishes replies and cancels late updates without idle requests", async () => {
    vi.useFakeTimers();
    let next!: (device: ManagedDevice) => void;
    const other = { ...device, id: "other" };
    const progress = vi.fn(); const send = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn();
    const result = collectDevicePresence([device, other], "nonce", (callback) => {
      next = callback; return stop;
    }, send, undefined, progress);
    expect(progress).toHaveBeenCalledExactlyOnceWith([device, other], [device.id, other.id]);
    next({ ...device, desktopName: "Fresh", heartbeatRequestId: "nonce" });
    expect(progress.mock.lastCall?.[0][0].desktopName).toBe("Fresh");
    expect(progress.mock.lastCall?.[1]).toEqual([other.id]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result)[1].status).toBe("offline");
    const updates = progress.mock.calls.length;
    next({ ...other, heartbeatRequestId: "nonce" });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(progress).toHaveBeenCalledTimes(updates);
    expect(send).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts only the requested reply, closes its listener and has zero idle repeats", async () => {
    vi.useFakeTimers();
    let next!: (device: ManagedDevice) => void;
    const stop = vi.fn(); const send = vi.fn().mockResolvedValue(undefined);
    const result = collectDevicePresence([device], "nonce", (callback) => { next = callback; return stop; }, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(device, "refresh-status nonce");
    next({ ...device, heartbeatRequestId: "old" });
    expect(stop).not.toHaveBeenCalled();
    next({ ...device, heartbeatRequestId: "nonce" });
    expect((await result)[0].status).toBe("online");
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(send).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("times out unavailable targets without changing persistent state or looping", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(); const send = vi.fn().mockResolvedValue(undefined);
    const result = collectDevicePresence([device], "nonce", () => stop, send);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect((await result)[0].status).toBe("offline");
    expect(device.status).toBe("online");
    expect(stop).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  });

  it("stops on cancellation and request errors without retries", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(); const stop = vi.fn(); const send = vi.fn().mockResolvedValue(undefined);
    const result = collectDevicePresence([device], "nonce", () => stop, send, abort.signal);
    abort.abort(); await expect(result).rejects.toThrow("cancelled");
    const failed = collectDevicePresence([device], "nonce", () => stop, async () => { throw new Error("Quota"); });
    await expect(failed).rejects.toThrow("Quota");
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(stop).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce();
  });

  it("drops removed targets, preserves fresh metadata and gives newly discovered targets five seconds", async () => {
    vi.useFakeTimers();
    let finishRead!: (devices: ManagedDevice[]) => void;
    const read = new Promise<ManagedDevice[]>(resolve => { finishRead = resolve; });
    let next!: (device: ManagedDevice) => void;
    const stop = vi.fn(); const send = vi.fn().mockResolvedValue(undefined); const progress = vi.fn();
    const removed = { ...device, id: "removed" }; const added = { ...device, id: "new" };
    const result = collectDevicePresence([device, removed], "nonce", callback => { next = callback; return stop; }, send, undefined, progress, read);
    expect(send).toHaveBeenCalledTimes(2);
    next({ ...device, heartbeatRequestId: "nonce" });
    await vi.advanceTimersByTimeAsync(2_000);
    finishRead([{ ...device, desktopName: "Renamed" }, added]);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.mock.lastCall?.[0].map((d: ManagedDevice) => d.id)).toEqual([device.id, added.id]);
    expect(progress.mock.lastCall?.[0][0].desktopName).toBe("Renamed");
    expect(progress.mock.lastCall?.[1]).toEqual([added.id]);
    next({ ...removed, heartbeatRequestId: "nonce" });
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).map(d => [d.id, d.status])).toEqual([[device.id, "online"], [added.id, "offline"]]);
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["read", "command", "listener"])("closes parallel refresh on %s failure without retries", async (failure) => {
    vi.useFakeTimers();
    let finishRead!: (devices: ManagedDevice[]) => void;
    let failRead!: (error: Error) => void;
    const read = new Promise<ManagedDevice[]>((resolve, reject) => { finishRead = resolve; failRead = reject; });
    let failListener!: (error: Error) => void;
    const stop = vi.fn(); const progress = vi.fn();
    const send = vi.fn(() => failure === "command" ? Promise.reject(new Error("Quota")) : Promise.resolve());
    const result = collectDevicePresence([device], "nonce", (_next, fail) => { failListener = fail; return stop; }, send, undefined, progress, read);
    const rejected = expect(result).rejects.toThrow("Quota");
    if (failure === "read") failRead(new Error("Quota"));
    if (failure === "listener") failListener(new Error("Quota"));
    await vi.advanceTimersByTimeAsync(0);
    if (failure !== "read") finishRead([device]);
    await rejected;
    const updates = progress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(progress).toHaveBeenCalledTimes(updates);
    expect(stop).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not recheck expired known targets when a slow list read finally finishes", async () => {
    vi.useFakeTimers();
    let finishRead!: (devices: ManagedDevice[]) => void;
    const read = new Promise<ManagedDevice[]>(resolve => { finishRead = resolve; });
    const stop = vi.fn(); const send = vi.fn().mockResolvedValue(undefined);
    const result = collectDevicePresence([device], "nonce", () => stop, send, undefined, undefined, read);
    await vi.advanceTimersByTimeAsync(5_000);
    finishRead([device]);
    expect((await result)[0].status).toBe("offline");
    expect(send).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a removed device error or an old manual timeout override the fresh list", async () => {
    vi.useFakeTimers();
    let finishRead!: (devices: ManagedDevice[]) => void;
    const read = new Promise<ManagedDevice[]>(resolve => { finishRead = resolve; });
    const removed = { ...device, id: "removed" };
    const stop = vi.fn();
    const result = collectDevicePresence([device, removed], "nonce", () => stop,
      async item => { if (item.id === removed.id) throw new Error("Permission denied"); }, undefined, undefined, read);
    await vi.advanceTimersByTimeAsync(5_000);
    finishRead([{ ...device, presenceMode: undefined }]);
    expect(await result).toEqual([{ ...device, presenceMode: undefined }]);
    expect(stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not require timer freshness for manual Agents, but keeps legacy freshness checks", () => {
    expect(resolveDeviceStatuses([device])[0].status).toBe("online");
    expect(resolveDeviceStatuses([{ ...device, presenceMode: undefined }])[0].status).toBe("offline");
  });

  it("routes one real local refresh command and returns the Agent heartbeat response", async () => {
    const server = createApiServer([device]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (route: string, data: unknown) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      expect(response.status).toBe(200); return response.json();
    };
    try {
      const refresh = fetch(`${base}/api/devices?refresh=1`).then((response) => response.json());
      let action = "";
      await vi.waitFor(async () => {
        const result = await post("/api/agent/commands", { deviceId: device.id, installId: "test0001" });
        action = result.commands[0]?.action ?? "";
        expect(action).toMatch(/^refresh-status /);
      });
      await post("/api/agent/heartbeat", { deviceId: device.id, installId: "test0001", presenceMode: "manual", heartbeatRequestId: action.split(" ")[1] });
      const result = await refresh;
      expect(result.devices[0]).toMatchObject({ status: "online", heartbeatRequestId: action.split(" ")[1] });
      expect((await post("/api/agent/commands", { deviceId: device.id, installId: "test0001" })).commands).toEqual([]);
      expect((await post("/api/sessions", { deviceId: device.id })).session.state).toBe("connected");
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
