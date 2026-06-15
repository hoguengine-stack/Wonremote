import { describe, expect, it } from "vitest";
import {
  BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY,
  resolveProductionUpdatePublicKey,
} from "./updateTrust";

describe("production update trust", () => {
  it("uses a bundled public key when no runtime override is configured", () => {
    expect(resolveProductionUpdatePublicKey({})).toBe(BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY);
    expect(BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY).toContain("-----BEGIN PUBLIC KEY-----");
  });

  it("allows an environment public key to override the bundled release key", () => {
    const overrideKey = [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEA1111111111111111111111111111111111111111111=",
      "-----END PUBLIC KEY-----",
    ].join("\n");

    expect(
      resolveProductionUpdatePublicKey({
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: `  ${overrideKey}  `,
      }),
    ).toBe(overrideKey);
  });
});
