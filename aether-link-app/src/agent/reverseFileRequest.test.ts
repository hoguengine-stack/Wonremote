import { describe, expect, it, vi } from "vitest";
import { createReverseFileRequest } from "./reverseFileRequest";
import { createSerializedAgentCommandQueue } from "./agentCommandExecution";

describe("reverse file request lifecycle", () => {
  it("reselects a local source with the persisted transfer ID after recreation", async () => {
    const sendFile = vi.fn(async () => {}), select = vi.fn(async () => "C:\\Reports\\report.bin");
    const requests = createReverseFileRequest({ context: () => ({ key: "new-session", sendFile }), select, onError: vi.fn() });
    expect(requests.request("C:\\secret.bin")).toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(requests.request("reverse-persisted")).toBe(true);
    expect(requests.request("reverse-persisted")).toBe(false);
    await vi.waitFor(() => expect(sendFile).toHaveBeenCalledOnce());
    expect(select).toHaveBeenCalledOnce();
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "C:\\Reports\\report.bin", transferId: "reverse-persisted" }));
  });
  it.each(["success", "selection-failed", "send-failed", "cancelled"])("reports bounded %s states without raw errors", async result => {
    const sendStatus = vi.fn();
    const requests = createReverseFileRequest({ context: () => ({ key: "current", sendStatus,
      sendFile: async () => { if (result === "send-failed") throw new Error("C:\\private-secret"); },
    }), select: async () => {
      if (result === "selection-failed") throw new Error("C:\\private-secret");
      return result === "cancelled" ? null : "C:\\report.txt";
    }, onError: vi.fn() });
    expect(requests.request()).toBe(true);
    const expected = result === "success" ? ["selecting", "sending", "complete"]
      : result === "send-failed" ? ["selecting", "sending", "send-failed"] : ["selecting", result];
    await vi.waitFor(() => expect(sendStatus.mock.calls.map(([value]) => value.state)).toEqual(expected));
    requests.cancel();
    expect(sendStatus).toHaveBeenCalledTimes(expected.length);
    expect(JSON.stringify(sendStatus.mock.calls)).not.toContain("private-secret");
  });
  it("does not block queued mouse input while a file dialog is pending", async () => {
    let choose!: (path: string | null) => void;
    const select = vi.fn(() => new Promise<string | null>(resolve => { choose = resolve; }));
    const sendFile = vi.fn(async () => {});
    const onError = vi.fn();
    const requests = createReverseFileRequest({ context: () => ({ key: "session:1", sendFile }), select, onError });
    const queue = createSerializedAgentCommandQueue();
    const mouse = vi.fn();
    await queue.enqueue(() => requests.request());
    await queue.enqueue(mouse);
    expect(mouse).toHaveBeenCalledOnce();
    expect(requests.request()).toBe(false);
    expect(select).toHaveBeenCalledOnce();
    choose("C:\\Reports\\report.txt");
    await vi.waitFor(() => expect(sendFile).toHaveBeenCalledOnce());
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "C:\\Reports\\report.txt", transferId: expect.stringMatching(/^reverse-/) }));
    expect(onError).not.toHaveBeenCalled();
  });
  it("ignores a late selection after the session changes", async () => {
    let key = "old", choose!: (value: string) => void;
    const sendFile = vi.fn(async () => {});
    const requests = createReverseFileRequest({ context: () => ({ key, sendFile }), select: () => new Promise(resolve => { choose = resolve; }), onError: vi.fn() });
    requests.request(); key = "new"; choose("C:\\private.txt");
    await Promise.resolve(); await Promise.resolve();
    expect(sendFile).not.toHaveBeenCalled();
  });
  it("cancels a file selection and suppresses its late result", async () => {
    let choose!: (value: string) => void, signal!: AbortSignal;
    const sendFile = vi.fn(async () => {}), onError = vi.fn();
    const requests = createReverseFileRequest({ context: () => ({ key: "same", sendFile }), select: input => {
      signal = input; return new Promise(resolve => { choose = resolve; });
    }, onError });
    requests.request(); requests.cancel(); choose("C:\\a.txt");
    await Promise.resolve(); await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(sendFile).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  });
  it("reports failures without making the next request permanently busy", async () => {
    const onError = vi.fn();
    const requests = createReverseFileRequest({ context: () => ({ key: "same", sendFile: vi.fn() }), select: async () => { throw new Error("dialog failed"); }, onError });
    requests.request(); await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(requests.request()).toBe(true);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });
});
