export const BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAwwhk0hWhfnVUQc8DS6XsT1XGaFNLBa94h//lHmRPIzY=",
  "-----END PUBLIC KEY-----",
].join("\n");

export function resolveProductionUpdatePublicKey(
  env: Partial<Record<"WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY", string>> = process.env,
): string {
  return env.WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY?.trim() || BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY;
}
