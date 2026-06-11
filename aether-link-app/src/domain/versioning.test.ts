import { describe, expect, it } from "vitest";
import { getViewerVersion, isHigherVersion } from "./versioning";

describe("viewer versioning", () => {
  it("reads the viewer version from Vite build-time env", () => {
    expect(
      getViewerVersion({
        VITE_AETHER_LINK_APP_VERSION: "0.1.1",
      }),
    ).toBe("0.1.1");
  });

  it("does not treat the same package version as an update", () => {
    expect(isHigherVersion("0.1.1", "0.1.1")).toBe(false);
  });

  it("detects a higher semantic version", () => {
    expect(isHigherVersion("0.1.2", "0.1.1")).toBe(true);
  });
});
