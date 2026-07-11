import { describe, expect, it } from "vitest";
import {
  buildSecureChallengeId,
  generateSecurityCode,
  isSecureChallengeExpired,
  normalizeSecurityCode,
} from "./secureSession";

describe("secure session helpers", () => {
  it("generates six digit codes grouped as 000 000", () => {
    expect(generateSecurityCode(() => 7)).toBe("000 007");
    expect(generateSecurityCode(() => 999999)).toBe("999 999");
  });

  it("rejects broken random sources instead of emitting malformed codes", () => {
    expect(() => generateSecurityCode(() => Number.NaN)).toThrow("out-of-range");
    expect(() => generateSecurityCode(() => 1_000_000)).toThrow("out-of-range");
    expect(() => buildSecureChallengeId(1234, () => -1)).toThrow("out-of-range");
  });

  it("normalizes viewer-entered security codes", () => {
    expect(normalizeSecurityCode("123 456")).toBe("123456");
    expect(normalizeSecurityCode("123-456")).toBe("123456");
    expect(normalizeSecurityCode(" 1 2 3 4 5 6 ")).toBe("123456");
  });

  it("creates challenge ids and detects expiration", () => {
    expect(buildSecureChallengeId(1234, () => 4321)).toBe("secure-1234-4321");
    expect(isSecureChallengeExpired(1_000, 1_001)).toBe(true);
    expect(isSecureChallengeExpired(1_000, 1_000)).toBe(false);
  });
});
