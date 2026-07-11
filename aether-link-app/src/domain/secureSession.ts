export const SECURE_SESSION_TTL_MS = 120_000;

export function generateSecurityCode(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  const value = requireBoundedRandomInt(randomInt, 1_000_000);
  const code = value.toString().padStart(6, "0");
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function normalizeSecurityCode(code: string): string {
  return code.replace(/\D/g, "");
}

export function buildSecureChallengeId(nowMs: number = Date.now(), randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  const suffix = requireBoundedRandomInt(randomInt, 10_000).toString().padStart(4, "0");
  return `secure-${Math.floor(nowMs)}-${suffix}`;
}

export function secureChallengeExpiresAt(nowMs: number = Date.now()): number {
  return nowMs + SECURE_SESSION_TTL_MS;
}

export function isSecureChallengeExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  return expiresAtMs < nowMs;
}

function defaultRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new RangeError("Secure random upper bound is invalid.");
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto is required to generate a secure connection code.");
  }
  const range = 0x1_0000_0000;
  const unbiasedLimit = Math.floor(range / maxExclusive) * maxExclusive;
  const values = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(values);
  } while (values[0] >= unbiasedLimit);
  return values[0] % maxExclusive;
}

function requireBoundedRandomInt(randomInt: (maxExclusive: number) => number, maxExclusive: number): number {
  const value = randomInt(maxExclusive);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxExclusive) {
    throw new Error("Secure random source returned an out-of-range value.");
  }
  return value;
}
