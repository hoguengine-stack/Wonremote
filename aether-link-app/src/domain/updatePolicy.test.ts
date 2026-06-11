import { describe, expect, it } from "vitest";
import { shouldNotifyUpdate, shouldReloadViewerForUpdate } from "./updatePolicy";

describe("update policy", () => {
  it("notifies on newer versions without forcing a viewer reload by default", () => {
    const update = { latestVersion: "0.1.2" };

    expect(shouldNotifyUpdate(update, "0.1.1")).toBe(true);
    expect(shouldReloadViewerForUpdate(update, "0.1.1")).toBe(false);
  });

  it("reloads the viewer only when the update check explicitly allows it", () => {
    expect(shouldReloadViewerForUpdate({ latestVersion: "0.1.2", reloadViewer: true }, "0.1.1")).toBe(true);
    expect(shouldReloadViewerForUpdate({ latestVersion: "0.1.1", reloadViewer: true }, "0.1.1")).toBe(false);
  });
});
