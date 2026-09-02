import type { RemoteSession } from "./types";

export const ACTIVE_SESSION_STORAGE_KEY = "wonremote-viewer-active-session";
export const SESSION_CLEANUP_STORAGE_KEY = "wonremote-viewer-session-cleanup";

interface ActiveSessionStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

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

export function consumeActiveSessionForStartupCleanup(storage: ActiveSessionStorage): RemoteSession | null {
  const session = parseActiveSession(storage.getItem(ACTIVE_SESSION_STORAGE_KEY));
  storage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  return session;
}

export function readSessionCleanupQueue(storage: ActiveSessionStorage): RemoteSession[] {
  try {
    const values = JSON.parse(storage.getItem(SESSION_CLEANUP_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(values)) return [];
    const sessions = values
      .map((value) => parseActiveSession(JSON.stringify(value)))
      .filter((session): session is RemoteSession => session !== null);
    return [...new Map(sessions.map((session) => [session.id, session])).values()];
  } catch {
    return [];
  }
}

export function enqueueSessionCleanup(storage: ActiveSessionStorage, session: RemoteSession): void {
  const sessions = readSessionCleanupQueue(storage).filter((item) => item.id !== session.id);
  storage.setItem(SESSION_CLEANUP_STORAGE_KEY, JSON.stringify([...sessions, session]));
}

export function removeSessionCleanup(storage: ActiveSessionStorage, sessionId: string): void {
  const sessions = readSessionCleanupQueue(storage).filter((session) => session.id !== sessionId);
  if (sessions.length === 0) {
    storage.removeItem(SESSION_CLEANUP_STORAGE_KEY);
    return;
  }
  storage.setItem(SESSION_CLEANUP_STORAGE_KEY, JSON.stringify(sessions));
}
