import { describe, expect, it } from "vitest";
import {
  consumeRemoteTextInput,
  finishRemoteComposition,
  isExactCtrlShortcut,
  isRemoteTextInputKeystroke,
  replaceRemoteComposition,
  pressTrackedKey,
  pressTrackedMouseButton,
  releaseTrackedKeyByRemoteKey,
  releaseTrackedKey,
  releaseTrackedMouseButton,
  releaseTrackedMouseButtonsMissingFromMask,
  normalizeWheelDelta,
  shouldUseReliableInputFallback,
  shouldForwardTrackedKeyRepeat,
} from "./viewerInputState";

describe("Viewer input state", () => {
  it("captures ordinary printable keys through the local IME but preserves Ctrl shortcuts", () => {
    expect(isRemoteTextInputKeystroke({ key: "a" })).toBe(true);
    expect(isRemoteTextInputKeystroke({ key: "Process", isComposing: true, shiftKey: true })).toBe(true);
    expect(isRemoteTextInputKeystroke({ key: "v", ctrlKey: true })).toBe(false);
    expect(isRemoteTextInputKeystroke({ key: "A", code: "KeyA", shiftKey: true })).toBe(false);
    expect(isRemoteTextInputKeystroke({ key: "\n", code: "Enter", isComposing: true, shiftKey: true })).toBe(false);
    expect(isRemoteTextInputKeystroke({ key: "F5" })).toBe(false);
  });

  it("reserves only plain Ctrl shortcuts for Viewer-specific handling", () => {
    expect(isExactCtrlShortcut({ key: "Escape", ctrlKey: true }, "Escape")).toBe(true);
    expect(isExactCtrlShortcut({ key: "v", ctrlKey: true }, "v")).toBe(true);
    expect(isExactCtrlShortcut({ key: "Escape", ctrlKey: true, shiftKey: true }, "Escape")).toBe(false);
    expect(isExactCtrlShortcut({ key: "v", ctrlKey: true, shiftKey: true }, "v")).toBe(false);
    expect(isExactCtrlShortcut({ key: "v", ctrlKey: true, altKey: true }, "v")).toBe(false);
  });

  it("emits completed Korean composition once even when a trailing input event repeats it", () => {
    const completed = finishRemoteComposition("한");
    expect(completed).toEqual({ text: "한", suppressNextValue: "한" });
    expect(consumeRemoteTextInput("한", false, completed.suppressNextValue)).toEqual({
      text: "",
      suppressNextValue: "",
    });
    expect(finishRemoteComposition("", "한")).toEqual({ text: "한", suppressNextValue: "한" });
  });

  it("emits plain local text once and ignores intermediate composition input", () => {
    expect(consumeRemoteTextInput("ㅎ", true, "")).toEqual({ text: "", suppressNextValue: "" });
    expect(consumeRemoteTextInput("abc", false, "")).toEqual({ text: "abc", suppressNextValue: "" });
  });

  it("replaces Korean preedit text on every composition update", () => {
    expect(replaceRemoteComposition("", "ㅎ")).toEqual({ deleteCount: 0, text: "ㅎ", changed: true });
    expect(replaceRemoteComposition("ㅎ", "하")).toEqual({ deleteCount: 1, text: "하", changed: true });
    expect(replaceRemoteComposition("하", "한")).toEqual({ deleteCount: 1, text: "한", changed: true });
    expect(replaceRemoteComposition("한", "한")).toEqual({ deleteCount: 0, text: "", changed: false });
  });

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

  it("keeps a real drag pressed while the browser still reports the button", () => {
    const pressed = new Set<0 | 1 | 2>([0]);

    expect(releaseTrackedMouseButtonsMissingFromMask(pressed, 1)).toEqual([]);
    expect([...pressed]).toEqual([0]);
  });

  it("repairs a missed pointer-up before the next buttonless move", () => {
    const pressed = new Set<0 | 1 | 2>([0, 2]);

    expect(releaseTrackedMouseButtonsMissingFromMask(pressed, 0)).toEqual([0, 2]);
    expect(pressed.size).toBe(0);
  });

  it("maps the browser buttons bitmask to left, middle, and right buttons", () => {
    const pressed = new Set<0 | 1 | 2>([0, 1, 2]);

    expect(releaseTrackedMouseButtonsMissingFromMask(pressed, 5)).toEqual([2]);
    expect([...pressed]).toEqual([0, 1]);
  });

  it("deduplicates keydown and releases the original token by physical key identity", () => {
    const pressed = new Map<string, string>();

    expect(pressTrackedKey(pressed, "KeyA", "A")).toBe(true);
    expect(pressTrackedKey(pressed, "KeyA", "a")).toBe(false);
    expect(releaseTrackedKey(pressed, "KeyA")).toBe("A");
    expect(releaseTrackedKey(pressed, "KeyA")).toBeNull();
  });

  it("forwards repeat keydown only while the same physical key remains pressed", () => {
    const pressed = new Map<string, string>();

    expect(shouldForwardTrackedKeyRepeat(pressed, "Backspace", "Backspace")).toBe(false);
    expect(pressTrackedKey(pressed, "Backspace", "Backspace")).toBe(true);
    expect(shouldForwardTrackedKeyRepeat(pressed, "Backspace", "Backspace")).toBe(true);
    expect(shouldForwardTrackedKeyRepeat(pressed, "Backspace", "Delete")).toBe(false);
    expect(releaseTrackedKey(pressed, "Backspace")).toBe("Backspace");
    expect(shouldForwardTrackedKeyRepeat(pressed, "Backspace", "Backspace")).toBe(false);
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
