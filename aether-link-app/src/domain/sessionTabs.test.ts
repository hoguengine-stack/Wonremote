import { describe, expect, it } from "vitest";
import type { RemoteSession } from "./types";
import { closeSessionTab, selectSessionTab, upsertSessionTab } from "./sessionTabs";

function session(id: string, deviceId: string): RemoteSession {
  return { id, deviceId, state: "connected", startedAt: "2026-09-02T00:00:00.000Z" };
}

describe("session tabs", () => {
  it("keeps one tab per device and replaces that device's session", () => {
    const first = session("session-1", "device-1");
    const second = session("session-2", "device-2");
    const replacement = session("session-3", "device-1");
    const tabs = upsertSessionTab(upsertSessionTab([first], second), replacement);

    expect(tabs).toEqual([replacement, second]);
    expect(selectSessionTab(tabs, "session-2")).toBe("session-2");
    expect(selectSessionTab(tabs, "missing")).toBeNull();
  });

  it("selects the next tab after closing the active session", () => {
    const tabs = [session("session-1", "device-1"), session("session-2", "device-2"), session("session-3", "device-3")];

    expect(closeSessionTab(tabs, "session-2", "session-2")).toEqual({
      sessions: [tabs[0], tabs[2]],
      activeSessionId: "session-3",
    });
    expect(closeSessionTab(tabs, "session-1", "session-3")).toEqual({
      sessions: [tabs[1], tabs[2]],
      activeSessionId: "session-3",
    });
    expect(closeSessionTab([tabs[0]], "session-1", "session-1")).toEqual({
      sessions: [],
      activeSessionId: null,
    });
  });
});
