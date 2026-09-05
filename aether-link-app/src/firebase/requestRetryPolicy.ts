export function firebaseRequestRetryDelayMs(error: unknown): number {
  const code = String((error as { code?: unknown; status?: unknown } | null)?.code ?? (error as { status?: unknown } | null)?.status ?? "").toLowerCase();
  return /resource[-_]exhausted|permission[-_]denied|unauthenticated|429/.test(code) ? 300_000 : 60_000;
}
