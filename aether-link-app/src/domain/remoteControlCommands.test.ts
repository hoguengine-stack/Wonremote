import { describe, expect, it } from "vitest";
import {
  buildKeyboardCommand,
  buildMouseCommand,
  buildPasteTextCommand,
  buildReplaceUnicodeTextCommand,
  buildUnicodeTextCommand,
  buildSystemCommand,
  decodeUtf8Base64,
  encodeUtf8Base64,
  formatTransferStats,
  isHangulToggleKey,
  mapCanvasPointToAbsolute,
  mapCanvasPointToVirtualDesktopAbsolute,
  normalizeRemoteKey,
} from "./remoteControlCommands";

describe("remote control command helpers", () => {
  it("maps canvas points into the 0..65535 SendInput absolute range", () => {
    expect(mapCanvasPointToAbsolute(50, 25, { left: 0, top: 0, width: 100, height: 50 })).toEqual({
      dx: 32768,
      dy: 32768,
    });
    expect(mapCanvasPointToAbsolute(-10, 90, { left: 0, top: 0, width: 100, height: 50 })).toEqual({
      dx: 0,
      dy: 65535,
    });
  });

  it("maps a selected monitor into the full virtual desktop coordinate range", () => {
    const displays = [
      { x: -1280, y: 0, width: 1280, height: 1024 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ];
    const secondaryCenter = mapCanvasPointToVirtualDesktopAbsolute(
      50,
      50,
      { left: 0, top: 0, width: 100, height: 100 },
      displays[0],
      displays,
    );
    const primaryCenter = mapCanvasPointToVirtualDesktopAbsolute(
      50,
      50,
      { left: 0, top: 0, width: 100, height: 100 },
      displays[1],
      displays,
    );

    expect(secondaryCenter.dx).toBeLessThan(32768);
    expect(primaryCenter.dx).toBeGreaterThan(32768);
    expect(primaryCenter.dy).toBe(32768);
  });

  it("keeps legacy single-display mapping when monitor origins are unavailable", () => {
    expect(
      mapCanvasPointToVirtualDesktopAbsolute(
        50,
        25,
        { left: 0, top: 0, width: 100, height: 50 },
        { width: 100, height: 50 },
        [{ width: 100, height: 50 }],
      ),
    ).toEqual({ dx: 32768, dy: 32768 });
  });

  it("normalizes browser key names to stable agent tokens", () => {
    expect(normalizeRemoteKey(" ")).toBe("Space");
    expect(normalizeRemoteKey("Control")).toBe("Ctrl");
    expect(normalizeRemoteKey("Escape")).toBe("Esc");
    expect(normalizeRemoteKey("Meta")).toBe("Win");
    expect(buildKeyboardCommand("keydown", "ArrowLeft")).toBe("key-down Left");
    expect(buildKeyboardCommand("keyup", "A")).toBe("key-up A");
    expect(buildKeyboardCommand("keydown", "Process", "Lang1")).toBe("key-down Hangul");
    expect(buildKeyboardCommand("keyup", "HangulMode", "Lang1")).toBe("key-up Hangul");
    expect(buildKeyboardCommand("keydown", "Process", "", 0x15)).toBe("key-down Hangul");
    expect(buildKeyboardCommand("keyup", "Process", "", 0x15)).toBe("key-up Hangul");
    expect(isHangulToggleKey("Process", "Lang1")).toBe(true);
    expect(isHangulToggleKey("HangulMode", "")).toBe(true);
    expect(isHangulToggleKey("Process", "", 0x15)).toBe(true);
    expect(isHangulToggleKey("A", "KeyA", 65)).toBe(false);
  });

  it("preserves physical keys for Shift and multi-modifier shortcuts", () => {
    expect(buildKeyboardCommand("keydown", "A", "KeyA")).toBe("key-down A");
    expect(buildKeyboardCommand("keydown", "!", "Digit1")).toBe("key-down 1");
    expect(buildKeyboardCommand("keydown", "_", "Minus")).toBe("key-down OemMinus");
    expect(buildKeyboardCommand("keydown", "+", "Equal")).toBe("key-down OemPlus");
    expect(buildKeyboardCommand("keydown", "Enter", "NumpadEnter")).toBe("key-down Enter");
    expect(buildKeyboardCommand("keydown", "ContextMenu", "ContextMenu")).toBe("key-down ContextMenu");
    expect(buildKeyboardCommand("keydown", "PrintScreen", "PrintScreen")).toBe("key-down PrintScreen");
  });

  it("builds ordered key transitions for common remote shortcuts", () => {
    expect([
      buildKeyboardCommand("keydown", "Shift", "ShiftLeft"),
      buildKeyboardCommand("keydown", "Enter", "Enter"),
      buildKeyboardCommand("keyup", "Enter", "Enter"),
      buildKeyboardCommand("keyup", "Shift", "ShiftLeft"),
    ]).toEqual(["key-down Shift", "key-down Enter", "key-up Enter", "key-up Shift"]);
    expect([
      buildKeyboardCommand("keydown", "Control", "ControlLeft"),
      buildKeyboardCommand("keydown", "Shift", "ShiftLeft"),
      buildKeyboardCommand("keydown", "Escape", "Escape"),
    ]).toEqual(["key-down Ctrl", "key-down Shift", "key-down Esc"]);
    expect([
      buildKeyboardCommand("keydown", "Alt", "AltLeft"),
      buildKeyboardCommand("keydown", "Tab", "Tab"),
    ]).toEqual(["key-down Alt", "key-down Tab"]);
  });

  it("builds mouse commands without changing the existing absolute coordinate mechanism", () => {
    expect(buildMouseCommand("move", 100, 200)).toBe("move 100 200");
    expect(buildMouseCommand("down", 100, 200, 2)).toBe("mouse-down 100 200 right");
    expect(buildMouseCommand("up", 100, 200, 0)).toBe("mouse-up 100 200 left");
    expect(buildMouseCommand("wheel", 100, 200, 0, -120)).toBe("mouse-wheel 100 200 -120");
  });

  it("encodes paste text safely for Korean, whitespace, and symbols", () => {
    const text = "한글 입력 test 123 !@#";
    const encoded = encodeUtf8Base64(text);
    expect(decodeUtf8Base64(encoded)).toBe(text);
    expect(buildPasteTextCommand(text)).toBe(`paste-text-base64 ${encoded}`);
  });

  it("encodes ordinary Unicode typing for direct Win32 text injection", () => {
    const text = "한😀";
    expect(buildUnicodeTextCommand(text)).toBe(`text-base64 ${encodeUtf8Base64(text)}`);
  });

  it("encodes one atomic replacement for live IME preedit text", () => {
    expect(buildReplaceUnicodeTextCommand(1, "한")).toBe(
      `text-replace-base64 1 ${encodeUtf8Base64("한")}`,
    );
    expect(buildReplaceUnicodeTextCommand(2, "")).toBe("text-replace-base64 2 -");
    expect(() => buildReplaceUnicodeTextCommand(4097, "한")).toThrow("between 0 and 4096");
  });

  it("limits system command names to the supported safe whitelist", () => {
    expect(buildSystemCommand("taskmgr")).toBe("system taskmgr");
    expect(buildSystemCommand("run")).toBe("system run");
    expect(() => buildSystemCommand("calc && format")).toThrow("Unsupported system command");
  });

  it("formats chunk transfer progress, speed, and remaining time", () => {
    expect(formatTransferStats(512 * 1024, 1024 * 1024, 0, 1000)).toEqual({
      progress: 50,
      speed: "512.00 KB/s",
      timeLeft: "1s",
    });
  });
});
