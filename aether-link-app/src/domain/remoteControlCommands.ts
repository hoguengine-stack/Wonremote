export interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RemoteDisplayBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export type KeyboardCommandType = "keydown" | "keyup";
export type MouseCommandType = "move" | "down" | "up" | "wheel";
export type MouseButtonCode = 0 | 1 | 2;

export const SUPPORTED_SYSTEM_COMMANDS = [
  "services.msc",
  "taskmgr",
  "cmd",
  "explorer",
  "devmgmt.msc",
  "lock",
  "logoff",
  "restart",
  "shutdown",
] as const;

export type SupportedSystemCommand = (typeof SUPPORTED_SYSTEM_COMMANDS)[number];

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  Alt: "Alt",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "Backspace",
  CapsLock: "CapsLock",
  Control: "Ctrl",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Escape: "Esc",
  Home: "Home",
  Insert: "Insert",
  Meta: "Win",
  NumLock: "NumLock",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Shift: "Shift",
  Tab: "Tab",
};

export function mapCanvasPointToAbsolute(clientX: number, clientY: number, rect: CanvasRect) {
  const localX = clamp(clientX - rect.left, 0, rect.width);
  const localY = clamp(clientY - rect.top, 0, rect.height);
  return {
    dx: Math.round((localX / Math.max(1, rect.width)) * 65535),
    dy: Math.round((localY / Math.max(1, rect.height)) * 65535),
  };
}

export function mapCanvasPointToVirtualDesktopAbsolute(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
  activeDisplay: RemoteDisplayBounds | undefined,
  displays: RemoteDisplayBounds[] | undefined,
) {
  const positionedDisplays = displays?.filter(
    (display) =>
      typeof display.x === "number" &&
      Number.isFinite(display.x) &&
      typeof display.y === "number" &&
      Number.isFinite(display.y) &&
      Number.isFinite(display.width) &&
      Number.isFinite(display.height) &&
      display.width > 0 &&
      display.height > 0,
  );
  if (
    !activeDisplay ||
    typeof activeDisplay.x !== "number" ||
    typeof activeDisplay.y !== "number" ||
    !positionedDisplays ||
    positionedDisplays.length !== displays?.length
  ) {
    return mapCanvasPointToAbsolute(clientX, clientY, rect);
  }

  const virtualLeft = Math.min(...positionedDisplays.map((display) => display.x as number));
  const virtualTop = Math.min(...positionedDisplays.map((display) => display.y as number));
  const virtualRight = Math.max(...positionedDisplays.map((display) => (display.x as number) + display.width));
  const virtualBottom = Math.max(...positionedDisplays.map((display) => (display.y as number) + display.height));
  const localX = clamp(clientX - rect.left, 0, rect.width) / Math.max(1, rect.width);
  const localY = clamp(clientY - rect.top, 0, rect.height) / Math.max(1, rect.height);
  const virtualX = activeDisplay.x + localX * activeDisplay.width;
  const virtualY = activeDisplay.y + localY * activeDisplay.height;

  return {
    dx: Math.round(clamp((virtualX - virtualLeft) / Math.max(1, virtualRight - virtualLeft), 0, 1) * 65535),
    dy: Math.round(clamp((virtualY - virtualTop) / Math.max(1, virtualBottom - virtualTop), 0, 1) * 65535),
  };
}

export function normalizeRemoteKey(key: string, code = ""): string {
  if (code === "Lang1" || key === "HangulMode") {
    return "Hangul";
  }
  if (code === "Lang2" || key === "HanjaMode") {
    return "Hanja";
  }
  if (KEY_ALIASES[key]) {
    return KEY_ALIASES[key];
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    return key;
  }
  return key.length === 1 ? key : key.replace(/\s+/g, "");
}

export function buildKeyboardCommand(type: KeyboardCommandType, key: string, code = ""): string {
  return `${type === "keydown" ? "key-down" : "key-up"} ${normalizeRemoteKey(key, code)}`;
}

export function buildMouseCommand(
  type: MouseCommandType,
  dx: number,
  dy: number,
  button: MouseButtonCode = 0,
  deltaY = 0,
): string {
  if (type === "move") {
    return `move ${dx} ${dy}`;
  }
  if (type === "wheel") {
    return `mouse-wheel ${dx} ${dy} ${Math.trunc(deltaY)}`;
  }
  return `mouse-${type} ${dx} ${dy} ${mouseButtonName(button)}`;
}

export function buildPasteTextCommand(text: string): string {
  return `paste-text-base64 ${encodeUtf8Base64(text)}`;
}

export function buildUnicodeTextCommand(text: string): string {
  return `text-base64 ${encodeUtf8Base64(text)}`;
}

export function buildSystemCommand(command: string): string {
  if (!isSupportedSystemCommand(command)) {
    throw new Error(`Unsupported system command: ${command}`);
  }
  return `system ${command}`;
}

export function buildSwitchMonitorCommand(index: number): string {
  return `switch-monitor ${Math.max(0, Math.trunc(index))}`;
}

export function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeUtf8Base64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

export function formatTransferStats(sentBytes: number, totalBytes: number, startedAtMs: number, nowMs: number) {
  const elapsedSeconds = Math.max(0.1, (nowMs - startedAtMs) / 1000);
  const bytesPerSecond = sentBytes / elapsedSeconds;
  const remainingBytes = Math.max(0, totalBytes - sentBytes);
  const remainingSeconds = bytesPerSecond > 0 ? Math.ceil(remainingBytes / bytesPerSecond) : 0;
  return {
    progress: totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0,
    speed: `${formatBytes(bytesPerSecond)}/s`,
    timeLeft: `${remainingSeconds}s`,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function isSupportedSystemCommand(command: string): command is SupportedSystemCommand {
  return SUPPORTED_SYSTEM_COMMANDS.includes(command as SupportedSystemCommand);
}

function mouseButtonName(button: MouseButtonCode): "left" | "middle" | "right" {
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  return "left";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
