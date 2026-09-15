import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_VIEW_PREFERENCES,
  deviceViewPreferencesKey,
  parseDeviceViewPreferences,
} from "./deviceViewPreferences";

describe("device view preferences", () => {
  it("restores only supported input modes", () => {
    expect(parseDeviceViewPreferences('{"inputMode":"touchpad"}').inputMode).toBe("touchpad");
    expect(parseDeviceViewPreferences('{"inputMode":"screen"}').inputMode).toBe("screen");
    expect(parseDeviceViewPreferences('{"inputMode":"invalid"}').inputMode).toBeUndefined();
  });
  it("restores device quality without accepting unsupported values", () => {
    expect(parseDeviceViewPreferences(JSON.stringify({ streamPerformanceMode: "fast" })).streamPerformanceMode).toBe("fast");
    expect(parseDeviceViewPreferences(JSON.stringify({ streamPerformanceMode: "normal" })).streamPerformanceMode).toBe("normal");
    expect(parseDeviceViewPreferences(JSON.stringify({ streamPerformanceMode: "invalid" })).streamPerformanceMode).toBeUndefined();
    expect(parseDeviceViewPreferences("{}").streamPerformanceMode).toBeUndefined();
  });
  it("uses safe defaults for missing or invalid settings", () => {
    expect(parseDeviceViewPreferences(null)).toEqual(DEFAULT_DEVICE_VIEW_PREFERENCES);
    expect(parseDeviceViewPreferences("invalid")).toEqual(DEFAULT_DEVICE_VIEW_PREFERENCES);
  });

  it("restores and bounds device-specific settings", () => {
    expect(parseDeviceViewPreferences(JSON.stringify({
      clipboardSync: true,
      fullscreen: true,
      selectedDisplayIndex: 2,
      zoom: 99,
    }))).toEqual({
      clipboardSync: true,
      fullscreen: true,
      selectedDisplayIndex: 2,
      zoom: 8,
    });
    expect(deviceViewPreferencesKey("device:1")).toBe("wonremote-device-view:device:1");
  });
});
