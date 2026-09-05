import { describe, expect, it } from "vitest";
import { formatDeviceSystemInfo, sanitizeDeviceSystemInfo } from "./deviceSystemInfo";

describe("device system info", () => {
  it("sanitizes bounded strings and positive memory bytes", () => {
    expect(sanitizeDeviceSystemInfo({
      cpuModel: `  Intel\n${"N".repeat(140)}  `,
      memoryBytes: 4 * 1024 ** 3,
      osVersion: "  Win10  ",
    })).toEqual({
      cpuModel: `Intel ${"N".repeat(114)}`,
      memoryBytes: 4 * 1024 ** 3,
      osVersion: "Win10",
    });
  });

  it.each([
    undefined,
    {},
    { cpuModel: "N95", memoryBytes: 0, osVersion: "Win10" },
    { cpuModel: "N95", memoryBytes: Number.POSITIVE_INFINITY, osVersion: "Win10" },
    { cpuModel: "N95", memoryBytes: "4294967296", osVersion: "Win10" },
    { cpuModel: " ", memoryBytes: 4 * 1024 ** 3, osVersion: "Win10" },
  ])("rejects invalid data %#", (value) => {
    expect(sanitizeDeviceSystemInfo(value)).toBeUndefined();
    expect(formatDeviceSystemInfo(value)).toBe("정보 없음");
  });

  it("formats common CPU names as a compact one-line label", () => {
    expect(formatDeviceSystemInfo({
      cpuModel: "Intel(R) Processor N95",
      memoryBytes: 4 * 1024 ** 3,
      osVersion: "Win10",
    })).toBe("N95 · 4GB · Win10");

    expect(formatDeviceSystemInfo({
      cpuModel: "Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz",
      memoryBytes: 8 * 1024 ** 3,
      osVersion: "Win11",
    })).toBe("i5-8500 · 8GB · Win11");

    expect(formatDeviceSystemInfo({
      cpuModel: "Intel(R) Celeron(R) CPU J1900 @ 1.99GHz",
      memoryBytes: Math.floor(3.8 * 1024 ** 3),
      osVersion: "Win10",
    })).toBe("J1900 · 4GB · Win10");
  });

  it("keeps unknown CPU text compact", () => {
    const label = formatDeviceSystemInfo({
      cpuModel: "Example Vendor Extremely Long Embedded Processor Model 123456789",
      memoryBytes: 2 * 1024 ** 3,
      osVersion: "Linux 6.8.0",
    });

    expect(label).toContain("… · 2GB · Linux 6.8.0");
    expect(label).not.toContain("\n");
  });
});
