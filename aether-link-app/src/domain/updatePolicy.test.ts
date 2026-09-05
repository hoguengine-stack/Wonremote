import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWER_UPDATE_INTERVAL_MS,
  resolveViewerUpdateIntervalMs,
  shouldNotifyUpdate,
} from "./updatePolicy";

describe("update policy", () => {
  it("notifies on newer versions without forcing a viewer reload by default", () => {
    const update = { latestVersion: "0.1.2" };

    expect(shouldNotifyUpdate(update, "0.1.1")).toBe(true);
  });

  it("throttles recurring update checks while preserving a configurable interval", () => {
    expect(resolveViewerUpdateIntervalMs({})).toBe(DEFAULT_VIEWER_UPDATE_INTERVAL_MS);
    expect(resolveViewerUpdateIntervalMs({ VITE_WONREMOTE_UPDATE_INTERVAL_MS: "1000" })).toBe(60_000);
    expect(resolveViewerUpdateIntervalMs({ VITE_WONREMOTE_UPDATE_INTERVAL_MS: "3600000" })).toBe(3_600_000);
  });
});
