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
