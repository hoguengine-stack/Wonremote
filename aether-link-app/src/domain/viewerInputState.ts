import type { MouseButtonCode } from "./remoteControlCommands";

type RemoteTextKeystroke = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

export function isRemoteTextInputKeystroke(event: RemoteTextKeystroke): boolean {
  if (event.code === "Enter" || event.code === "NumpadEnter") {
    return false;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  if (event.isComposing || event.key === "Process") {
    return true;
  }
  return !event.shiftKey && event.key.length === 1;
}

export function isExactCtrlShortcut(event: RemoteTextKeystroke, key: string): boolean {
  return Boolean(
    event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey
    && event.key.toLowerCase() === key.toLowerCase(),
  );
}

export function finishRemoteComposition(text: string, inputValue = ""): {
  text: string;
  suppressNextValue: string;
} {
  const completedText = text || inputValue;
  return { text: completedText, suppressNextValue: completedText };
}

export function consumeRemoteTextInput(
  value: string,
  isComposing: boolean,
  suppressNextValue: string,
): { text: string; suppressNextValue: string } {
  if (isComposing) {
    return { text: "", suppressNextValue };
  }
  if (suppressNextValue && value === suppressNextValue) {
    return { text: "", suppressNextValue: "" };
  }
  return { text: value, suppressNextValue: "" };
}

export function replaceRemoteComposition(previousText: string, nextText: string): {
  deleteCount: number;
  text: string;
  changed: boolean;
} {
  if (previousText === nextText) {
    return { deleteCount: 0, text: "", changed: false };
  }
  return {
    deleteCount: Array.from(previousText).length,
    text: nextText,
    changed: true,
  };
}

export function pressTrackedMouseButton(
  pressed: Set<MouseButtonCode>,
  browserButton: number,
): MouseButtonCode | null {
  const button = normalizeMouseButton(browserButton);
  if (button === null || pressed.has(button)) {
    return null;
  }
  pressed.add(button);
  return button;
}

export function releaseTrackedMouseButton(
  pressed: Set<MouseButtonCode>,
  browserButton: number,
): MouseButtonCode | null {
  const button = normalizeMouseButton(browserButton);
  if (button === null || !pressed.delete(button)) {
    return null;
  }
  return button;
}

export function releaseTrackedMouseButtonsMissingFromMask(
  pressed: Set<MouseButtonCode>,
  browserButtons: number,
): MouseButtonCode[] {
  const released: MouseButtonCode[] = [];
  for (const button of pressed) {
    if ((browserButtons & browserButtonsMask(button)) === 0) {
      pressed.delete(button);
      released.push(button);
    }
  }
  return released;
}

export function pressTrackedKey(
  pressed: Map<string, string>,
  physicalKey: string,
  remoteKey: string,
): boolean {
  if (!physicalKey || !remoteKey || pressed.has(physicalKey)) {
    return false;
  }
  pressed.set(physicalKey, remoteKey);
  return true;
}

export function shouldForwardTrackedKeyRepeat(
  pressed: Map<string, string>,
  physicalKey: string,
  remoteKey: string,
): boolean {
  return Boolean(physicalKey && remoteKey && pressed.get(physicalKey) === remoteKey);
}

export function releaseTrackedKey(
  pressed: Map<string, string>,
  physicalKey: string,
): string | null {
  const remoteKey = pressed.get(physicalKey) ?? null;
  if (remoteKey !== null) {
    pressed.delete(physicalKey);
  }
  return remoteKey;
}

export function releaseTrackedKeyByRemoteKey(
  pressed: Map<string, string>,
  remoteKey: string,
): boolean {
  let released = false;
  for (const [physicalKey, trackedRemoteKey] of pressed) {
    if (trackedRemoteKey === remoteKey) {
      pressed.delete(physicalKey);
      released = true;
    }
  }
  return released;
}

export function normalizeWheelDelta(deltaY: number): -120 | 0 | 120 {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 0;
  }
  return deltaY > 0 ? -120 : 120;
}

export function shouldUseReliableInputFallback(action: string): boolean {
  return !action.trimStart().startsWith("move ");
}

function normalizeMouseButton(button: number): MouseButtonCode | null {
  return button === 0 || button === 1 || button === 2 ? button : null;
}

function browserButtonsMask(button: MouseButtonCode): number {
  if (button === 0) return 1;
  if (button === 1) return 4;
  return 2;
}
