import { describe, expect, it } from "vitest";
import { appendCaptureDiagnostic, CAPTURE_DIAGNOSTIC_LIMIT } from "./captureDiagnostics";

describe("capture diagnostic memory", () => {
  it("bounds a long capture session and preserves the latest backend failure", () => {
    let tail = "";
    for (let i = 0; i < 1000; i++) tail = appendCaptureDiagnostic(tail, "frame diagnostic\n".repeat(100));
    tail = appendCaptureDiagnostic(tail, "DXGI_ERROR_ACCESS_LOST");
    expect(tail.length).toBe(CAPTURE_DIAGNOSTIC_LIMIT);
    expect(tail.endsWith("DXGI_ERROR_ACCESS_LOST")).toBe(true);
  });
  it("bounds a single oversized line without needing a newline", () => {
    expect(appendCaptureDiagnostic("", "x".repeat(1_000_000)).length).toBe(CAPTURE_DIAGNOSTIC_LIMIT);
  });
});
