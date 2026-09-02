import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS,
  AGENT_UPDATE_FAILURE_RETRY_MS,
  MIN_AGENT_UPDATE_CHECK_INTERVAL_MS,
  MIN_TEST_AGENT_UPDATE_CHECK_INTERVAL_MS,
  resolveAgentUpdateCheckIntervalMs,
  resolveAgentUpdateFailureRetryMs,
  shouldRetryFailedAgentUpdate,
  shouldAttemptAgentUpdateCheck,
} from "./agentUpdatePollPolicy";

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent update polling policy", () => {
  it("uses a 15 minute default and clamps configuration to at least 60 seconds", () => {
    expect(resolveAgentUpdateCheckIntervalMs({})).toBe(DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS);
    expect(resolveAgentUpdateCheckIntervalMs({ WONREMOTE_AGENT_UPDATE_CHECK_MS: "10000" })).toBe(
      MIN_AGENT_UPDATE_CHECK_INTERVAL_MS,
    );
    expect(resolveAgentUpdateCheckIntervalMs({ WONREMOTE_AGENT_UPDATE_CHECK_MS: "120000" })).toBe(120_000);
    expect(resolveAgentUpdateCheckIntervalMs({ WONREMOTE_AGENT_UPDATE_CHECK_MS: "invalid" })).toBe(
      DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS,
    );
  });

  it("allows a short explicit interval only in the isolated test runtime", () => {
    expect(resolveAgentUpdateCheckIntervalMs({
      NODE_ENV: "test",
      WONREMOTE_TEST_AGENT_UPDATE_CHECK_MS: "500",
    })).toBe(500);
    expect(resolveAgentUpdateCheckIntervalMs({
      NODE_ENV: "test",
      WONREMOTE_TEST_AGENT_UPDATE_CHECK_MS: "1",
    })).toBe(MIN_TEST_AGENT_UPDATE_CHECK_INTERVAL_MS);
    expect(resolveAgentUpdateCheckIntervalMs({
      NODE_ENV: "production",
      WONREMOTE_TEST_AGENT_UPDATE_CHECK_MS: "500",
    })).toBe(DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS);
  });

  it("runs immediately once and throttles heartbeat checks from the last attempt time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    let lastAttemptAtMs: number | null = null;

    expect(shouldAttemptAgentUpdateCheck(Date.now(), lastAttemptAtMs, DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    lastAttemptAtMs = Date.now();

    vi.advanceTimersByTime(10_000);
    expect(shouldAttemptAgentUpdateCheck(Date.now(), lastAttemptAtMs, DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS)).toBe(false);

    vi.advanceTimersByTime(DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS - 10_001);
    expect(shouldAttemptAgentUpdateCheck(Date.now(), lastAttemptAtMs, DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(shouldAttemptAgentUpdateCheck(Date.now(), lastAttemptAtMs, DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it("retries an update failure after one minute instead of waiting fifteen minutes", () => {
    expect(resolveAgentUpdateFailureRetryMs(DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS)).toBe(
      AGENT_UPDATE_FAILURE_RETRY_MS,
    );
    expect(resolveAgentUpdateFailureRetryMs(30_000)).toBe(30_000);
  });

  it("retries the same failed target only after the failure cooldown", () => {
    const failedAt = "2026-07-11T00:00:00.000Z";
    expect(shouldRetryFailedAgentUpdate({ failedAt, nowMs: Date.parse(failedAt) + 59_999, retryAfterMs: 60_000 }))
      .toBe(false);
    expect(shouldRetryFailedAgentUpdate({ failedAt, nowMs: Date.parse(failedAt) + 60_000, retryAfterMs: 60_000 }))
      .toBe(true);
  });
});
