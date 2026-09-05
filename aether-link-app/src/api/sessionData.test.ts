import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeLocalSessionData } from "./sessionData";
import { emptySessionData } from "../domain/sessionData";
import { createApiServer } from "../server/apiServer";
import type { AddressInfo } from "node:net";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("local session change delivery", () => {
  it("holds one idle request for 24h without polling, serializes processing and cancels on exit", async () => {
    vi.useFakeTimers();
    let reply!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise((resolve) => { reply = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    let finish!: () => void;
    const received = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = subscribeLocalSessionData("http://local", "s", "viewer", received, vi.fn());
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fetcher).toHaveBeenCalledOnce();
    reply({ ok: true, json: async () => ({ ...emptySessionData(), revision: 0 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledTimes(2);
    stop();
    reply({ ok: true, json: async () => ({ ...emptySessionData(), revision: 1 }) });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(received).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[1] as any)[1].signal.aborted).toBe(true);
  });

  it("does not loop on errors or a nonadvancing revision", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetcher);
    const onError = vi.fn();
    subscribeLocalSessionData("http://local", "s", "agent", vi.fn(), onError);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fetcher).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledOnce();
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...emptySessionData(), revision: 0 }) });
    subscribeLocalSessionData("http://local", "s", "agent", vi.fn(), onError);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(onError).toHaveBeenCalledTimes(2);
  });

  it("stops receipt-only delivery after all requested transfers finish", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      ...emptySessionData(), revision: 0, receipts: [{ transferId: "one", status: "received" }],
    }) });
    vi.stubGlobal("fetch", fetcher);
    const received = vi.fn();
    const stop = subscribeLocalSessionData("http://local", "s", "viewer", received, vi.fn(), { queues: false, receiptIds: ["one"] });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledOnce();
    stop();
  });

  it("delivers chat, clipboard, file and only requested receipts to the correct peer over real HTTP", async () => {
    const server = createApiServer([{
      id: "device", businessNumber: "123-45-67890", deviceNumber: "AGENT-1", deviceName: "POS", desktopName: "PC",
      storeName: "Store", status: "online", lastSeenAt: new Date().toISOString(),
    }]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200); return response.json();
    };
    const result = await post("/api/sessions", { deviceId: "device" });
    const id = result.session.id;
    const agent = vi.fn(); const viewer = vi.fn(); const errors = vi.fn();
    const stopAgent = subscribeLocalSessionData(base, id, "agent", agent, errors);
    const stopViewer = subscribeLocalSessionData(base, id, "viewer", viewer, errors, { clipboard: false, receiptIds: ["selected"] });
    try {
      await vi.waitFor(() => { expect(agent).toHaveBeenCalledOnce(); expect(viewer).toHaveBeenCalledOnce(); });
      await post(`/api/sessions/${id}/chat`, { message: "hello", sender: "viewer" });
      await post(`/api/sessions/${id}/clipboard`, { text: "clipboard", sender: "viewer" });
      await post(`/api/sessions/${id}/files`, { filename: "one.txt", fileData: "YQ==" });
      await vi.waitFor(() => {
        expect(agent.mock.calls.flatMap(([data]) => data.messages).map((item) => item.message)).toEqual(["hello"]);
        expect(agent.mock.calls.flatMap(([data]) => data.clipboards).map((item) => item.text)).toEqual(["clipboard"]);
        expect(agent.mock.calls.flatMap(([data]) => data.files).map((item) => item.filename)).toEqual(["one.txt"]);
      });
      expect(viewer.mock.calls.flatMap(([data]) => data.messages)).toEqual([]);
      await post(`/api/sessions/${id}/file-receipts`, { transferId: "unrelated", filename: "other", status: "received" });
      await post(`/api/sessions/${id}/file-receipts`, { transferId: "selected", filename: "one.txt", status: "received" });
      await vi.waitFor(() => expect(viewer.mock.calls.flatMap(([data]) => data.receipts).map((item) => item.transferId)).toContain("selected"));
      expect(viewer.mock.calls.flatMap(([data]) => data.receipts).some((item) => item.transferId === "unrelated")).toBe(false);
      await post(`/api/sessions/${id}/close`, {});
      await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    } finally {
      stopAgent(); stopViewer(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
