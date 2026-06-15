export const DEFAULT_STORE_NAME = "상호명 미설정";

export function normalizeStoreNameForDisplay(
  input: unknown,
  businessNumber: string,
  options: { preserveLegacyGeneratedName?: boolean } = {},
): string {
  const storeName = String(input ?? "").trim();
  const normalizedBusinessNumber = businessNumber.trim();

  if (!storeName) {
    return DEFAULT_STORE_NAME;
  }

  if (options.preserveLegacyGeneratedName) {
    return storeName;
  }

  const legacyGeneratedNames = new Set([
    `사업자 ${normalizedBusinessNumber}`,
    `?ъ뾽??${normalizedBusinessNumber}`,
    `??? ${normalizedBusinessNumber}`,
    `???${normalizedBusinessNumber}`,
  ]);

  if (legacyGeneratedNames.has(storeName)) {
    return DEFAULT_STORE_NAME;
  }

  if (/^\?+\s*/.test(storeName) && storeName.includes(normalizedBusinessNumber)) {
    return DEFAULT_STORE_NAME;
  }

  return storeName;
}
