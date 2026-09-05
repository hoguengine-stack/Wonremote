import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_VIEW_PREFERENCES,
  deviceViewPreferencesKey,
  parseDeviceViewPreferences,
} from "./deviceViewPreferences";

describe("device view preferences", () => {
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
