import { describe, expect, it } from "vitest";
import type { ManagedDevice } from "./types";
import {
  filterDeviceWorkspace,
  parseFavoriteDeviceIds,
  pruneSelectedDeviceIds,
  serializeFavoriteDeviceIds,
  sortDeviceWorkspace,
} from "./deviceWorkspace";

function device(
  id: string,
  overrides: Partial<ManagedDevice> & Record<string, unknown> = {},
): ManagedDevice {
  return {
    id,
    businessNumber: "123-45-67890",
    storeName: "서울점",
    deviceNumber: `AGENT-${id}`,
    deviceName: `Agent ${id}`,
    desktopName: `DESKTOP-${id}`,
    status: "online",
    lastSeenAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  } as ManagedDevice;
}

describe("device workspace", () => {
  it("applies status, store, query, and favorite filters together", () => {
    const result = filterDeviceWorkspace(
      [
        device("fav-attention", {
          desktopName: "Kiosk 2",
          updateState: "failed",
        }),
        device("other-attention", {
          desktopName: "Kiosk 10",
          updateState: "failed",
        }),
        device("offline-attention", {
          desktopName: "Kiosk 2",
          status: "offline",
          updateState: "failed",
        }),
        device("other-store", {
          desktopName: "Kiosk 2",
          storeName: "부산점",
          updateState: "failed",
        }),
      ],
      {
        status: "update-attention",
        query: "kiosk 2",
        selectedStore: "서울점",
        favoriteOnly: true,
        favoriteDeviceIds: ["fav-attention"],
      },
    );

    expect(result.map((item) => item.id)).toEqual(["fav-attention"]);
  });

  it("serializes unique favorite IDs and safely clears malformed storage values", () => {
    expect(serializeFavoriteDeviceIds(["device-1", "", "device-1", " device-2 "])).toBe(
      '["device-1","device-2"]',
    );
    expect(parseFavoriteDeviceIds('["device-1", " device-2 ", "device-1"]')).toEqual([
      "device-1",
      "device-2",
    ]);
    expect(parseFavoriteDeviceIds("not-json")).toEqual([]);
    expect(parseFavoriteDeviceIds('{"deviceId":"device-1"}')).toEqual([]);
  });

  it("keeps only selected IDs present in the current device list", () => {
    expect(
      pruneSelectedDeviceIds(["missing", "device-2", "device-1", "device-2"], [
        device("device-1"),
        device("device-2"),
      ]),
    ).toEqual(["device-2", "device-1"]);
  });

  it("sorts online devices first, favorites first within status, then natural desktop name", () => {
    const devices = [
      device("offline-favorite", { status: "offline", desktopName: "Desk 20" }),
      device("online-10", { desktopName: "Desk 10" }),
      device("online-2", { desktopName: "Desk 2" }),
      device("online-1-favorite", { desktopName: "Desk 1" }),
      device("offline-1", { status: "offline", desktopName: "Desk 1" }),
    ];

    expect(sortDeviceWorkspace(devices, ["online-1-favorite", "offline-favorite"]).map((item) => item.id)).toEqual([
      "online-1-favorite",
      "online-2",
      "online-10",
      "offline-favorite",
      "offline-1",
    ]);
  });

  it.each([
    ["kim", { contactName: "Kim Manager" }],
    ["basement", { installLocation: "Basement rack" }],
    ["priority", { tags: ["kiosk", "priority"] }],
    ["printer", { notes: "Printer failure history" }],
  ])("matches operational metadata query %s", (query, metadata) => {
    const result = filterDeviceWorkspace([
      device("matching", metadata),
      device("other"),
    ], { query });

    expect(result.map((item) => item.id)).toEqual(["matching"]);
  });
});
