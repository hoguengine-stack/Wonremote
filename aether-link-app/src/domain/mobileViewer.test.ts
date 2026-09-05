import { describe, expect, it } from "vitest";
import { isMobileViewerPath } from "./mobileViewer";

describe("mobile Viewer route", () => {
  it("recognizes only the installable Viewer route", () => {
    expect(isMobileViewerPath("/viewer")).toBe(true);
    expect(isMobileViewerPath("/viewer/")).toBe(true);
    expect(isMobileViewerPath("/")).toBe(false);
    expect(isMobileViewerPath("/ios-check")).toBe(false);
  });
});
