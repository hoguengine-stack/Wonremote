import { describe, expect, it } from "vitest";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "./deviceDefaults";

describe("device defaults", () => {
  it("normalizes empty and legacy generated store names", () => {
    expect(normalizeStoreNameForDisplay("", "123-45-67890")).toBe(DEFAULT_STORE_NAME);
    expect(normalizeStoreNameForDisplay("사업자 123-45-67890", "123-45-67890")).toBe(DEFAULT_STORE_NAME);
    expect(normalizeStoreNameForDisplay("??? 123-45-67890", "123-45-67890")).toBe(DEFAULT_STORE_NAME);
    expect(normalizeStoreNameForDisplay("???123-45-67890", "123-45-67890")).toBe(DEFAULT_STORE_NAME);
  });

  it("preserves manually entered store names", () => {
    expect(normalizeStoreNameForDisplay("강남 1호점", "123-45-67890")).toBe("강남 1호점");
    expect(
      normalizeStoreNameForDisplay("사업자 123-45-67890", "123-45-67890", {
        preserveLegacyGeneratedName: true,
      }),
    ).toBe("사업자 123-45-67890");
  });
});
