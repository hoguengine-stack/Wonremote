export type StreamCaptureBackend = "dxgi" | "gdi";

export interface FirestoreTileFallbackPolicy {
  enabled: boolean;
  diagnosticOnly: boolean;
  maxFrames: number;
  maxDurationMs: number;
}

export function resolveCommandPollIntervalMs(env: Partial<Record<string, string | undefined>>): number {
  const parsed = Number(env.WONREMOTE_AGENT_COMMAND_POLL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 250;
  }
  return Math.min(5_000, Math.max(100, Math.trunc(parsed)));
}

export function streamErrorSuggestsGdiFallback(stderrText: string): boolean {
  return /0x80070005|access is denied|permission denied|액세스가 거부/i.test(stderrText);
}

export function nextStreamCaptureBackend(
  currentBackend: StreamCaptureBackend,
  stderrText: string,
): StreamCaptureBackend {
  if (currentBackend === "dxgi" && streamErrorSuggestsGdiFallback(stderrText)) {
    return "gdi";
  }
  return currentBackend;
}

export function nextStreamRestartDelayMs(failureCount: number): number {
  const safeFailures = Math.max(0, Math.trunc(failureCount));
  return Math.min(5_000, 500 * 2 ** safeFailures);
}

export function resolveFirestoreTileFallbackPolicy(
  env: Partial<Record<string, string | undefined>>,
): FirestoreTileFallbackPolicy {
  const allowValue = env.WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK?.trim().toLowerCase();
  return {
    enabled: allowValue === "diagnostic",
    diagnosticOnly: true,
    maxFrames: parseBoundedInteger(env.WONREMOTE_FIRESTORE_STREAM_FALLBACK_MAX_FRAMES, 60, 1, 300),
    maxDurationMs: parseBoundedInteger(env.WONREMOTE_FIRESTORE_STREAM_FALLBACK_MAX_MS, 15_000, 1_000, 60_000),
  };
}

export function canPostFirestoreTileFallbackFrame(
  policy: FirestoreTileFallbackPolicy,
  state: { postedFrames: number; startedAtMs: number; nowMs: number },
): boolean {
  if (!policy.enabled) {
    return false;
  }
  if (state.postedFrames >= policy.maxFrames) {
    return false;
  }
  return state.nowMs - state.startedAtMs <= policy.maxDurationMs;
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
