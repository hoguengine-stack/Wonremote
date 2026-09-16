export const ACTIVE_SESSION_RECOVERY_MAX_AGE_MS = 30 * 60_000;

export interface RecoverableAgentSession {
  id: string;
  startedAtMs: number;
}

export function selectRecoverableAgentSession(
  sessions: readonly RecoverableAgentSession[],
  nowMs = Date.now(),
  maxAgeMs = ACTIVE_SESSION_RECOVERY_MAX_AGE_MS,
): RecoverableAgentSession | null {
  return sessions
    .filter(({ startedAtMs }) => {
      const ageMs = nowMs - startedAtMs;
      return Number.isFinite(startedAtMs) && startedAtMs > 0 && ageMs >= -60_000 && ageMs <= maxAgeMs;
    })
    .sort((left, right) => right.startedAtMs - left.startedAtMs)[0] ?? null;
}
