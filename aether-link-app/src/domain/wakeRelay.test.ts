import { describe, expect, it } from "vitest";
import type { ManagedDevice } from "./types";
import { normalizeWakeMac, selectViewerWakeRelay } from "./wakeRelay";

function device(overrides: Partial<ManagedDevice> & Pick<ManagedDevice, "id">): ManagedDevice {
  const { id, ...rest } = overrides;
  return {
    businessNumber: "123-45-67890",
    desktopName: "DESKTOP",
    deviceName: "Agent",
    deviceNumber: "AGENT-1",
    id,
    lastSeenAt: "2026-07-11T03:00:00.000Z",
    status: "online",
    storeName: "Store",
    ...rest,
  };
}

describe("viewer Wake-on-LAN relay selection", () => {
  it("normalizes only valid unicast MAC addresses", () => {
    expect(normalizeWakeMac("aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeWakeMac("FF:FF:FF:FF:FF:FF")).toBeNull();
    expect(normalizeWakeMac("bad")).toBeNull();
  });

  it("chooses the freshest online relay in the same business", () => {
    const relay = selectViewerWakeRelay(
      [
        device({ id: "target" }),
        device({ id: "old", lastSeenAt: "2026-07-11T02:59:30.000Z" }),
        device({ id: "fresh", lastSeenAt: "2026-07-11T02:59:55.000Z" }),
        device({ id: "other", businessNumber: "999-99-99999" }),
      ],
      { businessNumber: "123-45-67890", nowMs: Date.parse("2026-07-11T03:00:00.000Z"), targetDeviceId: "target" },
    );
    expect(relay?.id).toBe("fresh");
  });
});
