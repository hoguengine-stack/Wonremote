import { readFileSync } from "node:fs";
import path from "node:path";
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

  it("renders store before device in both the header and each row", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
    const styles = readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
    const tableStart = source.indexOf('<div className="table-row table-head">', source.indexOf("function DeviceTable"));
    const tableEnd = source.indexOf("{devices.length === 0", tableStart);
    const table = source.slice(tableStart, tableEnd);

    expect(table.indexOf("<span>매장</span>")).toBeLessThan(table.indexOf("<span>장비</span>"));
    expect(table.indexOf('className="store-cell"')).toBeLessThan(table.indexOf('className="device-identity-cell"'));
    expect(styles).toContain("> .store-cell { grid-column: 2; grid-row: 1; }");
    expect(styles).toContain("> .device-identity-cell { grid-column: 2; grid-row: 2; }");
  });
});
