import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("device list presentation", () => {
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

  it("keeps status and compact system information on one line", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
    const styles = readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
    const tableStart = source.indexOf('<div className="table-row table-head">', source.indexOf("function DeviceTable"));
    const tableEnd = source.indexOf("{devices.length === 0", tableStart);
    const table = source.slice(tableStart, tableEnd);
    const statusStyles = styles.slice(styles.indexOf(".status-pill {"), styles.indexOf(".status-pill.online"));
    const systemStyles = styles.slice(styles.indexOf(".device-system-cell {"), styles.indexOf(".device-identity-cell b"));

    expect(table.indexOf("<span>소프트웨어</span>")).toBeLessThan(table.indexOf("<span>시스템</span>"));
    expect(table.indexOf("<span>시스템</span>")).toBeLessThan(table.indexOf("<span>작업</span>"));
    expect(table).toContain('className="device-system-cell"');
    expect(statusStyles).toContain("white-space: nowrap;");
    expect(systemStyles).toContain("text-overflow: ellipsis;");
    expect(systemStyles).toContain("white-space: nowrap;");
    expect(styles).toMatch(/\.table-head\s*\{\s*display:\s*none;/u);
  });
});
