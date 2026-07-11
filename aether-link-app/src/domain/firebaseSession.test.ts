import { describe, expect, it } from "vitest";
import { createFirebaseSessionId, mapFirebaseSessionHistory } from "./firebaseSession";
import type { ManagedDevice } from "./types";

const device: ManagedDevice = {
  id: "123-45-67890:AGENT-01",
  businessNumber: "123-45-67890",
  storeName: "테스트 매장",
  deviceNumber: "AGENT-01",
  deviceName: "카운터",
  desktopName: "POS-01",
  status: "online",
  lastSeenAt: "2026-07-11T00:00:00.000Z",
};

describe("Firebase session lifecycle", () => {
  it("creates a unique reconnect-safe session id for every connection", () => {
    const first = createFirebaseSessionId(device.id, 1_000, 0.1);
    const second = createFirebaseSessionId(device.id, 1_001, 0.1);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^session-123-45-67890:AGENT-01-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("maps Firebase sessions to newest-first connection history", () => {
    const history = mapFirebaseSessionHistory(
      [
        {
          id: "older",
          data: {
            deviceId: device.id,
            startedAt: "2026-07-11T01:00:00.000Z",
            state: "closed",
            closedAt: { toDate: () => new Date("2026-07-11T01:10:00.000Z") },
          },
        },
        {
          id: "newer",
          data: {
            deviceId: device.id,
            startedAt: "2026-07-11T02:00:00.000Z",
            state: "connected",
          },
        },
        { id: "invalid", data: { deviceId: device.id } },
      ],
      [device],
    );

    expect(history.map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(history[0]).toMatchObject({ storeName: "테스트 매장", deviceName: "카운터", status: "success" });
    expect(history[1]).toMatchObject({ endedAt: "2026-07-11T01:10:00.000Z", status: "closed" });
  });
});
