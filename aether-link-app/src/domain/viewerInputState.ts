import type { MouseButtonCode } from "./remoteControlCommands";

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
