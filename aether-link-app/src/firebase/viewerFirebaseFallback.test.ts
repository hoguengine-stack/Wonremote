import { describe, expect, it } from "vitest";
import { resolveViewerFunctionMode, shouldUseFirestoreFallback } from "./viewerFirebase";

describe("Viewer Cloud Functions fallback policy", () => {
  it("uses direct Firestore by default while callable Functions are not deployed", () => {
    expect(resolveViewerFunctionMode({})).toBe("direct");
    expect(resolveViewerFunctionMode({ VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE: "auto" })).toBe("auto");
    expect(resolveViewerFunctionMode({ VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE: "callable" })).toBe("callable");
  });

  it("falls back only when Functions are absent or temporarily unavailable", () => {
    expect(shouldUseFirestoreFallback({ code: "functions/not-found" })).toBe(true);
    expect(shouldUseFirestoreFallback({ code: "functions/unimplemented" })).toBe(true);
    expect(shouldUseFirestoreFallback({ code: "functions/unavailable" })).toBe(true);
  });

  it("does not bypass server validation after internal or permission failures", () => {
    expect(shouldUseFirestoreFallback({ code: "functions/internal" })).toBe(false);
    expect(shouldUseFirestoreFallback({ code: "functions/permission-denied" })).toBe(false);
    expect(shouldUseFirestoreFallback(new Error("internal server error"))).toBe(false);
    expect(shouldUseFirestoreFallback(new Error("Firebase device not found."))).toBe(false);
  });
});
