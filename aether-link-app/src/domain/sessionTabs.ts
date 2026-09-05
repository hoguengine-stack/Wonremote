import type { RemoteSession } from "./types";

export interface ClosedSessionTabs {
  sessions: RemoteSession[];
  activeSessionId: string | null;
}

export function upsertSessionTab(
  sessions: readonly RemoteSession[],
  session: RemoteSession,
): RemoteSession[] {
  const existingIndex = sessions.findIndex((item) => item.deviceId === session.deviceId);
  const withoutDevice = sessions.filter((item) => item.deviceId !== session.deviceId);
  if (existingIndex < 0) {
    return [...withoutDevice, session];
  }
  withoutDevice.splice(Math.min(existingIndex, withoutDevice.length), 0, session);
  return withoutDevice;
}

export function closeSessionTab(
  sessions: readonly RemoteSession[],
  closedSessionId: string,
  activeSessionId: string | null,
): ClosedSessionTabs {
  const closedIndex = sessions.findIndex((session) => session.id === closedSessionId);
  const remaining = sessions.filter((session) => session.id !== closedSessionId);
  if (remaining.length === 0) {
    return { sessions: remaining, activeSessionId: null };
  }

  if (activeSessionId !== closedSessionId && remaining.some((session) => session.id === activeSessionId)) {
    return { sessions: remaining, activeSessionId };
  }

  if (closedIndex < 0) {
    return { sessions: remaining, activeSessionId: remaining[0].id };
  }
  const nextIndex = Math.min(closedIndex, remaining.length - 1);
  return { sessions: remaining, activeSessionId: remaining[nextIndex].id };
}
