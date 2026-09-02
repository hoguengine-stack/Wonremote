export const DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
export const AGENT_UPDATE_FAILURE_RETRY_MS = 60 * 1_000;
export const MIN_AGENT_UPDATE_CHECK_INTERVAL_MS = 60 * 1_000;
export const MIN_TEST_AGENT_UPDATE_CHECK_INTERVAL_MS = 100;

export function resolveAgentUpdateCheckIntervalMs(
  env: Partial<Record<
    "NODE_ENV" | "WONREMOTE_AGENT_UPDATE_CHECK_MS" | "WONREMOTE_TEST_AGENT_UPDATE_CHECK_MS",
    string | undefined
  >> = process.env,
): number {
  if (env.NODE_ENV === "test") {
    const testInterval = Number(env.WONREMOTE_TEST_AGENT_UPDATE_CHECK_MS);
    if (Number.isFinite(testInterval)) {
      return Math.max(MIN_TEST_AGENT_UPDATE_CHECK_INTERVAL_MS, Math.trunc(testInterval));
    }
  }
  const parsed = Number(env.WONREMOTE_AGENT_UPDATE_CHECK_MS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_AGENT_UPDATE_CHECK_INTERVAL_MS;
  }
  return Math.max(MIN_AGENT_UPDATE_CHECK_INTERVAL_MS, Math.trunc(parsed));
}

export function shouldAttemptAgentUpdateCheck(
  nowMs: number,
  lastAttemptAtMs: number | null,
  intervalMs: number,
): boolean {
  if (lastAttemptAtMs === null || nowMs < lastAttemptAtMs) {
    return true;
  }
  return nowMs - lastAttemptAtMs >= intervalMs;
}

export function resolveAgentUpdateFailureRetryMs(intervalMs: number): number {
  return Math.min(Math.max(AGENT_UPDATE_FAILURE_RETRY_MS, MIN_AGENT_UPDATE_CHECK_INTERVAL_MS), intervalMs);
}

export function shouldRetryFailedAgentUpdate(input: {
  failedAt: string | undefined;
  nowMs: number;
  retryAfterMs: number;
}): boolean {
  const failedAtMs = Date.parse(input.failedAt ?? "");
  if (!Number.isFinite(failedAtMs) || input.nowMs < failedAtMs) {
    return true;
  }
  return input.nowMs - failedAtMs >= Math.max(0, input.retryAfterMs);
}
