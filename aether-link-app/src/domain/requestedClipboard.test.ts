import { afterEach, describe, expect, it, vi } from "vitest";
import { requestFreshClipboardText } from "./requestedClipboard";
import { emptySessionData, type SessionData } from "./sessionData";

describe("explicit remote clipboard request", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores initial queued data and accepts a response delayed beyond 600ms", async () => {
    vi.useFakeTimers();
    let onData!: (data: SessionData) => void;
    let onReady!: () => void;
    const stop = vi.fn();
    const request = vi.fn();
    const pending = requestFreshClipboardText({
      request,
      subscribe: (data, _error, ready) => {
        onData = data;
        onReady = ready;
        return stop;
      },
      timeoutMs: 10_000,
    });

    onData({ ...emptySessionData(), clipboards: [{ sender: "agent", text: "stale" }] });
    expect(request).not.toHaveBeenCalled();
    onReady();
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    onData({ ...emptySessionData(), clipboards: [{ sender: "agent", text: "fresh" }] });

    await expect(pending).resolves.toBe("fresh");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("closes the subscription on timeout, error and abort", async () => {
    vi.useFakeTimers();
    const timeoutStop = vi.fn();
    let timeoutReady!: () => void;
    const timedOut = requestFreshClipboardText({
      request: vi.fn(),
      subscribe: (_data, _error, ready) => {
        timeoutReady = ready;
        return timeoutStop;
      },
      timeoutMs: 1_000,
    });
    timeoutReady();
    const timedOutAssertion = expect(timedOut).rejects.toThrow("시간 초과");
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOutAssertion;
    expect(timeoutStop).toHaveBeenCalledOnce();

    const errorStop = vi.fn();
    let fail!: (error: Error) => void;
    const failed = requestFreshClipboardText({
      request: vi.fn(),
      subscribe: (_data, onError) => {
        fail = onError;
        return errorStop;
      },
    });
    fail(new Error("listener failed"));
    await expect(failed).rejects.toThrow("listener failed");
    expect(errorStop).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const abortStop = vi.fn();
    const aborted = requestFreshClipboardText({
      request: vi.fn(),
      signal: controller.signal,
      subscribe: () => abortStop,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(abortStop).toHaveBeenCalledOnce();
  });
});
