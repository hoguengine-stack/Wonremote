import { describe, expect, it, vi } from "vitest";
import { waitForApiHealth } from "./agentHealth";

describe("agent API health wait", () => {
  it("retries until the API health endpoint is ready", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForApiHealth({
      apiBaseUrl: "http://127.0.0.1:8787",
      attempts: 5,
      fetchImpl,
      intervalMs: 25,
      sleep,
    });

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8787/api/health");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("returns false after exhausting all attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForApiHealth({
      apiBaseUrl: "http://127.0.0.1:8787",
      attempts: 3,
      fetchImpl,
      intervalMs: 10,
      sleep,
    });

    expect(result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
