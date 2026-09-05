import { describe, expect, it } from "vitest";
import { normalizeDevicePlatform } from "./devicePlatform";

describe("device platform", () => {
  it("keeps Android explicit and treats legacy device records as Windows", () => {
    expect(normalizeDevicePlatform("android")).toBe("android");
    expect(normalizeDevicePlatform("windows")).toBe("windows");
    expect(normalizeDevicePlatform(undefined)).toBe("windows");
    expect(normalizeDevicePlatform("ios")).toBe("windows");
  });
});
