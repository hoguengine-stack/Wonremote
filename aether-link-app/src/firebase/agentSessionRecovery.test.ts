import { describe, expect, it } from "vitest";
import {
  ACTIVE_SESSION_RECOVERY_MAX_AGE_MS,
  selectRecoverableAgentSession,
} from "./agentSessionRecovery";

describe("Agent active session recovery", () => {
  const now = Date.parse("2026-09-17T03:30:00.000Z");

  it("selects only the newest session inside the bounded restart window", () => {
    expect(selectRecoverableAgentSession([
      { id: "july-stale", startedAtMs: Date.parse("2026-07-12T18:24:03.776Z") },
      { id: "recent-older", startedAtMs: now - 10 * 60_000 },
      { id: "recent-newer", startedAtMs: now - 2 * 60_000 },
    ], now)).toEqual({ id: "recent-newer", startedAtMs: now - 2 * 60_000 });
  });

  it("rejects stale, invalid, and implausibly future connected sessions", () => {
    expect(selectRecoverableAgentSession([
      { id: "stale", startedAtMs: now - ACTIVE_SESSION_RECOVERY_MAX_AGE_MS - 1 },
      { id: "missing-time", startedAtMs: 0 },
      { id: "future", startedAtMs: now + 60_001 },
    ], now)).toBeNull();
  });
});
