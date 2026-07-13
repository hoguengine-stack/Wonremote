import { describe, expect, it } from "vitest";
import { sortDevicesForDisplay } from "./App";
import type { ManagedDevice } from "./domain/types";

function device(id: string, status: ManagedDevice["status"], desktopName: string): ManagedDevice {
  return {
    id,
    status,
    desktopName,
    deviceName: id,
    deviceNumber: id,
    businessNumber: "123-45-67890",
    storeName: "Test",
  } as ManagedDevice;
}

describe("device list presentation", () => {
  it("sorts online devices first, then desktop names naturally", () => {
    const result = sortDevicesForDisplay([
      device("offline-z", "offline", "Zeta 2"),
      device("online-b", "online", "가게 2"),
      device("online-a", "online", "가게 10"),
      device("offline-a", "offline", "Alpha"),
    ]);

    expect(result.map((item) => item.id)).toEqual(["online-b", "online-a", "offline-a", "offline-z"]);
  });
});
