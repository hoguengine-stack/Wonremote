import { describe, expect, it } from "vitest";
import type { ManagedDevice } from "./types";
import { clampSplitRatio, validateSameGroupSplit } from "./splitSessionView";

function device(id: string, overrides: Partial<ManagedDevice> = {}): ManagedDevice {
  return {
    id,
    businessNumber: "123-45-67890",
    storeName: "서울점",
    deviceNumber: `AGENT-${id}`,
    deviceName: `Agent ${id}`,
    desktopName: `DESKTOP-${id}`,
    status: "online",
    lastSeenAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("split session view", () => {
  it("accepts two online devices from the same store", () => {
    expect(validateSameGroupSplit([device("left"), device("right")])).toBeNull();
  });

  it.each([[device("only")], [device("one"), device("two"), device("three")]])(
    "rejects a device count other than two",
    (...devices) => {
      expect(validateSameGroupSplit(devices)).toBe("count");
    },
  );

  it("defers stale offline status to the connection backend", () => {
    expect(validateSameGroupSplit([device("left"), device("right", { status: "offline" })])).toBeNull();
  });

  it("rejects devices from different stores", () => {
    expect(validateSameGroupSplit([device("left"), device("right", { storeName: "부산점" })])).toBe(
      "different-group",
    );
  });

  it.each([
    [10, 20],
    [20, 20],
    [55, 55],
    [80, 80],
    [90, 80],
  ])("clamps split ratio %s to %s", (ratio, expected) => {
    expect(clampSplitRatio(ratio)).toBe(expected);
  });
});
