import { describe, expect, it } from "vitest";
import {
  canPostFirestoreTileFallbackFrame,
  nextStreamCaptureBackend,
  nextStreamRestartDelayMs,
  resolveCommandPollIntervalMs,
  resolveFirestoreTileFallbackPolicy,
  streamErrorSuggestsGdiFallback,
} from "./agentStreamPolicy";

describe("agent stream policy", () => {
  it("uses a fast command polling interval independent from heartbeat", () => {
    expect(resolveCommandPollIntervalMs({})).toBe(250);
    expect(resolveCommandPollIntervalMs({ WONREMOTE_AGENT_COMMAND_POLL_MS: "50" })).toBe(100);
    expect(resolveCommandPollIntervalMs({ WONREMOTE_AGENT_COMMAND_POLL_MS: "750" })).toBe(750);
    expect(resolveCommandPollIntervalMs({ WONREMOTE_AGENT_COMMAND_POLL_MS: "bad" })).toBe(250);
  });

  it("detects DXGI permission failures that need the GDI fallback backend", () => {
    expect(streamErrorSuggestsGdiFallback('DXGI capture failed: HRESULT(0x80070005) "Access is denied"')).toBe(true);
    expect(streamErrorSuggestsGdiFallback("DXGI 캡처 초기화 실패: 액세스가 거부되었습니다.")).toBe(true);
    expect(streamErrorSuggestsGdiFallback("temporary network timeout")).toBe(false);
  });

  it("switches only failed DXGI capture loops to GDI", () => {
    expect(nextStreamCaptureBackend("dxgi", "HRESULT(0x80070005)")).toBe("gdi");
    expect(nextStreamCaptureBackend("gdi", "HRESULT(0x80070005)")).toBe("gdi");
    expect(nextStreamCaptureBackend("dxgi", "normal close")).toBe("dxgi");
  });

  it("backs off crashed stream restarts without leaving the session dead", () => {
    expect(nextStreamRestartDelayMs(0)).toBe(500);
    expect(nextStreamRestartDelayMs(1)).toBe(1000);
    expect(nextStreamRestartDelayMs(4)).toBe(5000);
    expect(nextStreamRestartDelayMs(99)).toBe(5000);
  });

  it("keeps Firestore tile streaming disabled for production even when legacy flags are set", () => {
    expect(resolveFirestoreTileFallbackPolicy({}).enabled).toBe(false);
    expect(resolveFirestoreTileFallbackPolicy({ WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK: "0" }).enabled).toBe(false);
    expect(resolveFirestoreTileFallbackPolicy({ WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK: "true" })).toMatchObject({
      enabled: false,
      diagnosticOnly: true,
    });
  });

  it("allows Firestore tile streaming only as an explicit diagnostic path", () => {
    expect(resolveFirestoreTileFallbackPolicy({ WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK: "diagnostic" })).toMatchObject({
      enabled: true,
      diagnosticOnly: true,
      maxFrames: 60,
      maxDurationMs: 15_000,
    });
  });

  it("caps Firestore tile fallback to a short diagnostic budget", () => {
    const policy = resolveFirestoreTileFallbackPolicy({
      WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK: "diagnostic",
      WONREMOTE_FIRESTORE_STREAM_FALLBACK_MAX_FRAMES: "2",
      WONREMOTE_FIRESTORE_STREAM_FALLBACK_MAX_MS: "3000",
    });

    expect(canPostFirestoreTileFallbackFrame(policy, { postedFrames: 0, startedAtMs: 1000, nowMs: 2000 })).toBe(true);
    expect(canPostFirestoreTileFallbackFrame(policy, { postedFrames: 2, startedAtMs: 1000, nowMs: 2000 })).toBe(false);
    expect(canPostFirestoreTileFallbackFrame(policy, { postedFrames: 1, startedAtMs: 1000, nowMs: 4501 })).toBe(false);
  });
});
