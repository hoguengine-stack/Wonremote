export function firebaseRequestRetryDelayMs(error: unknown): number {
  const code = String((error as { code?: unknown; status?: unknown } | null)?.code ?? (error as { status?: unknown } | null)?.status ?? "").toLowerCase();
  return /resource[-_]exhausted|permission[-_]denied|unauthenticated|429/.test(code) ? 300_000 : 60_000;
}

export function firebaseCommandListenerRetryDelayMs(error: unknown, consecutiveFailures = 1): number {
  const generalDelayMs = firebaseRequestRetryDelayMs(error);
  const fallbackDelayMs = consecutiveFailures <= 1 ? 60_000 : consecutiveFailures === 2 ? 300_000 : 900_000;
  return Math.max(generalDelayMs, fallbackDelayMs);
}
