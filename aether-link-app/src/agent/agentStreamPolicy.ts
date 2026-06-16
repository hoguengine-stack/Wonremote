export type StreamCaptureBackend = "dxgi" | "gdi";

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
