import { describe, expect, it } from "vitest";
import type { ManagedDevice } from "./types";
import { prepareViewerDeviceList, resolveViewerOfflineAfterMs } from "./viewerDeviceList";

function device(overrides: Partial<ManagedDevice> & Pick<ManagedDevice, "id">): ManagedDevice {
  return {
    businessNumber: "123-45-67890",
    desktopName: `DESKTOP-${overrides.id}`,
    deviceName: `Agent ${overrides.id}`,
    deviceNumber: overrides.id,
    lastSeenAt: "2026-07-13T05:00:00.000Z",
    status: "online",
    storeName: "Store",
    ...overrides,
  };
}

describe("prepareViewerDeviceList", () => {
  it("uses the same bounded offline threshold as the Viewer refresh loop", () => {
    expect(resolveViewerOfflineAfterMs({})).toBe(60_000);
    expect(resolveViewerOfflineAfterMs({ VITE_WONREMOTE_AGENT_OFFLINE_MS: "5000" })).toBe(15_000);
    expect(resolveViewerOfflineAfterMs({ VITE_WONREMOTE_AGENT_OFFLINE_MS: "90000" })).toBe(90_000);
  });

  it("marks stale Firestore online records offline before the first render", () => {
    const result = prepareViewerDeviceList(
      [device({ id: "stale", lastSeenAt: "2026-07-13T04:58:00.000Z" })],
      "2026-07-13T05:00:00.000Z",
      60_000,
    );

    expect(result[0].status).toBe("offline");
  });

  it("keeps only the freshest registration for the same physical MAC set", () => {
    const result = prepareViewerDeviceList(
      [
        device({
          id: "old-registration",
          lastSeenAt: "2026-07-13T04:55:00.000Z",
          macAddresses: ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"],
        }),
        device({
          id: "current-registration",
          lastSeenAt: "2026-07-13T04:59:50.000Z",
          macAddresses: ["11-22-33-44-55-66", "aa-bb-cc-dd-ee-ff"],
        }),
      ],
      "2026-07-13T05:00:00.000Z",
      60_000,
    );

    expect(result.map((item) => item.id)).toEqual(["current-registration"]);
  });

  it("does not merge separate PCs that use the same business number", () => {
    const result = prepareViewerDeviceList(
      [
        device({ id: "pc-a", macAddresses: ["AA:BB:CC:DD:EE:01"] }),
        device({ id: "pc-b", macAddresses: ["AA:BB:CC:DD:EE:02"] }),
        device({ id: "unknown-a" }),
        device({ id: "unknown-b" }),
      ],
      "2026-07-13T05:00:10.000Z",
      60_000,
    );

    expect(result.map((item) => item.id).sort()).toEqual(["pc-a", "pc-b", "unknown-a", "unknown-b"]);
  });
});
