export type DevicePlatform = "windows" | "android";

export function normalizeDevicePlatform(value: unknown): DevicePlatform {
  return value === "android" ? "android" : "windows";
}
