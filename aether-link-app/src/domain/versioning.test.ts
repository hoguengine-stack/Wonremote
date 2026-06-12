import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WONREMOTE_APP_VERSION } from "./appVersion";
import { getViewerVersion, isHigherVersion } from "./versioning";

describe("viewer versioning", () => {
  it("keeps the shared app version aligned with package.json", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    expect(WONREMOTE_APP_VERSION).toBe(packageJson.version);
  });

  it("reads the viewer version from Vite build-time env", () => {
    expect(
      getViewerVersion({
        VITE_WONREMOTE_APP_VERSION: "0.1.1",
      }),
    ).toBe("0.1.1");
  });

  it("falls back to the shared app version when Vite env injection is unavailable", () => {
    expect(getViewerVersion({})).toBe(WONREMOTE_APP_VERSION);
  });

  it("does not treat the same package version as an update", () => {
    expect(isHigherVersion("0.1.1", "0.1.1")).toBe(false);
  });

  it("detects a higher semantic version", () => {
    expect(isHigherVersion("0.1.2", "0.1.1")).toBe(true);
  });
});
