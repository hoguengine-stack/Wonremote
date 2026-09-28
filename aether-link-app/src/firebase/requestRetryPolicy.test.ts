import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firebaseCommandListenerRetryDelayMs, firebaseRequestRetryDelayMs } from "./requestRetryPolicy";

describe("necessary background request retries", () => {
  it.each(["resource-exhausted", "firestore/resource-exhausted", "RESOURCE_EXHAUSTED", "permission-denied", "unauthenticated"])("backs off %s for five minutes", (code) => {
    expect(firebaseRequestRetryDelayMs({ code })).toBe(300_000);
  });
  it("backs off HTTP quota and transient failures without immediate retries", () => {
    expect(firebaseRequestRetryDelayMs({ status: 429 })).toBe(300_000);
    expect(firebaseRequestRetryDelayMs(new Error("offline"))).toBe(60_000);
    expect(firebaseRequestRetryDelayMs(null)).toBe(60_000);
  });
  it("uses bounded sparse command listener retries while preserving quota backoff", () => {
    expect(firebaseCommandListenerRetryDelayMs(new Error("offline"), 1)).toBe(60_000);
    expect(firebaseCommandListenerRetryDelayMs(new Error("offline"), 2)).toBe(300_000);
    expect(firebaseCommandListenerRetryDelayMs(new Error("offline"), 3)).toBe(900_000);
    expect(firebaseCommandListenerRetryDelayMs(new Error("offline"), 100)).toBe(900_000);
    expect(firebaseCommandListenerRetryDelayMs({ code: "resource-exhausted" }, 1)).toBe(300_000);
    expect(firebaseCommandListenerRetryDelayMs({ code: "permission-denied" }, 3)).toBe(900_000);
  });
  it("keeps Agent auxiliary delivery event-driven and heartbeats nonoverlapping", () => {
    const source = readFileSync(new URL("../agent/index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("fetchSessionDataWithFirebase");
    expect(source).not.toContain("sessionPollIntervalId");
    expect(source).toContain("subscribeAgentSessionData(sessionId, onData, onError)");
    expect(source).toContain("subscribeLocalSessionData(API_BASE_URL, sessionId, \"agent\", onData, onError)");
    expect(source).toContain("active && activeSessionId === sessionId");
    expect(source).toContain("agentHeartbeatGate.run(() => runAgentTick(config, requestId))");
    expect(source).toContain("Date.now() < heartbeatRetryAtMs");
    expect(source).toContain("schedule(firebaseCommandListenerRetryDelayMs(error, consecutiveFailures))");
    expect(source).toContain("available && !networkWasAvailable && firebaseCommandRetryTimer");
    expect(source).toContain("stopNetworkRecoveryWatch();");
  });
});
