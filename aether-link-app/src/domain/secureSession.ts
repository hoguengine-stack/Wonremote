export const SECURE_SESSION_TTL_MS = 120_000;

export function generateSecurityCode(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  const bounded = Math.max(0, Math.min(999_999, Math.floor(randomInt(1_000_000))));
  const code = bounded.toString().padStart(6, "0");
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function normalizeSecurityCode(code: string): string {
  return code.replace(/\D/g, "");
}

export function buildSecureChallengeId(nowMs: number = Date.now(), randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  const suffix = Math.max(0, Math.min(9_999, Math.floor(randomInt(10_000)))).toString().padStart(4, "0");
  return `secure-${Math.floor(nowMs)}-${suffix}`;
}

export function secureChallengeExpiresAt(nowMs: number = Date.now()): number {
  return nowMs + SECURE_SESSION_TTL_MS;
}

export function isSecureChallengeExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  return expiresAtMs < nowMs;
}

function defaultRandomInt(maxExclusive: number): number {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}
