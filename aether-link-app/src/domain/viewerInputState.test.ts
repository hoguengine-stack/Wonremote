import { describe, expect, it } from "vitest";
import {
  pressTrackedKey,
  pressTrackedMouseButton,
  releaseTrackedKeyByRemoteKey,
  releaseTrackedKey,
  releaseTrackedMouseButton,
  normalizeWheelDelta,
  shouldUseReliableInputFallback,
} from "./viewerInputState";

describe("Viewer input state", () => {
  it("ignores unsupported and duplicate mouse-button down transitions", () => {
    const pressed = new Set<0 | 1 | 2>();

    expect(pressTrackedMouseButton(pressed, 3)).toBeNull();
    expect(pressTrackedMouseButton(pressed, 0)).toBe(0);
    expect(pressTrackedMouseButton(pressed, 0)).toBeNull();
    expect([...pressed]).toEqual([0]);
  });

  it("releases only the mouse button represented by mouseup", () => {
    const pressed = new Set<0 | 1 | 2>([0, 2]);

    expect(releaseTrackedMouseButton(pressed, 2)).toBe(2);
    expect([...pressed]).toEqual([0]);
    expect(releaseTrackedMouseButton(pressed, 2)).toBeNull();
  });

  it("deduplicates keydown and releases the original token by physical key identity", () => {
    const pressed = new Map<string, string>();

    expect(pressTrackedKey(pressed, "KeyA", "A")).toBe(true);
    expect(pressTrackedKey(pressed, "KeyA", "a")).toBe(false);
    expect(releaseTrackedKey(pressed, "KeyA")).toBe("A");
    expect(releaseTrackedKey(pressed, "KeyA")).toBeNull();
  });

  it("can release a modifier by the remote token used for a synthesized shortcut", () => {
    const pressed = new Map<string, string>([["ControlLeft", "Ctrl"]]);

    expect(releaseTrackedKeyByRemoteKey(pressed, "Ctrl")).toBe(true);
    expect(pressed.size).toBe(0);
  });

  it("does not turn a zero or invalid wheel event into remote scrolling", () => {
    expect(normalizeWheelDelta(0)).toBe(0);
    expect(normalizeWheelDelta(Number.NaN)).toBe(0);
    expect(normalizeWheelDelta(1)).toBe(-120);
    expect(normalizeWheelDelta(-1)).toBe(120);
  });

  it("does not backlog lossy pointer movement through the reliable fallback", () => {
    expect(shouldUseReliableInputFallback("move 100 200")).toBe(false);
    expect(shouldUseReliableInputFallback("mouse-down 100 200 left")).toBe(true);
    expect(shouldUseReliableInputFallback("mouse-up 100 200 left")).toBe(true);
    expect(shouldUseReliableInputFallback("key-down Ctrl")).toBe(true);
    expect(shouldUseReliableInputFallback("key-up Ctrl")).toBe(true);
  });
});
