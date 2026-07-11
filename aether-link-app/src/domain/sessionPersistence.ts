import type { RemoteSession } from "./types";

export const ACTIVE_SESSION_STORAGE_KEY = "wonremote-viewer-active-session";

export function serializeActiveSession(session: RemoteSession): string {
  return JSON.stringify({
    deviceId: session.deviceId,
    id: session.id,
    startedAt: session.startedAt,
    state: session.state,
  });
}

export function parseActiveSession(value: string | null): RemoteSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RemoteSession>;
    if (
      typeof parsed.id !== "string" || !parsed.id.trim() ||
      typeof parsed.deviceId !== "string" || !parsed.deviceId.trim() ||
      typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt)) ||
      (parsed.state !== "pending" && parsed.state !== "connected")
    ) {
      return null;
    }
    return {
      id: parsed.id,
      deviceId: parsed.deviceId,
      startedAt: parsed.startedAt,
      state: parsed.state,
    };
  } catch {
    return null;
  }
}
