import { describe, expect, it } from "vitest";
import {
  ACTIVE_SESSION_STORAGE_KEY,
  consumeActiveSessionForStartupCleanup,
  parseActiveSession,
  serializeActiveSession,
} from "./sessionPersistence";

describe("viewer active session persistence", () => {
  it("round-trips only the reconnect contract", () => {
    const session = {
      deviceId: "device-1",
      id: "session-1",
      startedAt: "2026-07-11T03:00:00.000Z",
      state: "connected" as const,
    };
    expect(parseActiveSession(serializeActiveSession(session))).toEqual(session);
  });

  it("rejects malformed or closed session snapshots", () => {
    expect(parseActiveSession("not-json")).toBeNull();
    expect(parseActiveSession(JSON.stringify({ id: "s", deviceId: "d", startedAt: "bad", state: "connected" }))).toBeNull();
    expect(parseActiveSession(JSON.stringify({ id: "s", deviceId: "d", startedAt: "2026-07-11T03:00:00Z", state: "closed" }))).toBeNull();
  });

  it("consumes a persisted session for cleanup instead of startup restoration", () => {
    const stored = new Map<string, string>([
      [
        ACTIVE_SESSION_STORAGE_KEY,
        serializeActiveSession({
          deviceId: "device-1",
          id: "session-1",
          startedAt: "2026-09-02T00:00:00.000Z",
          state: "connected",
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      removeItem: (key: string) => stored.delete(key),
    };

    expect(consumeActiveSessionForStartupCleanup(storage)).toMatchObject({ id: "session-1" });
    expect(stored.has(ACTIVE_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("clears an invalid persisted session during startup cleanup", () => {
    const stored = new Map<string, string>([[ACTIVE_SESSION_STORAGE_KEY, "invalid"]]);
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      removeItem: (key: string) => stored.delete(key),
    };

    expect(consumeActiveSessionForStartupCleanup(storage)).toBeNull();
    expect(stored.has(ACTIVE_SESSION_STORAGE_KEY)).toBe(false);
  });
});
