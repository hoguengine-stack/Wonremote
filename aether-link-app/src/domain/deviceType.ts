export const DEFAULT_DEVICE_TYPE = "메인포스";
export const DEVICE_TYPE_PRESETS = [DEFAULT_DEVICE_TYPE, "오더포스"] as const;

export type DeviceTypeChoice = (typeof DEVICE_TYPE_PRESETS)[number] | "custom";

export function isGeneratedAgentDeviceName(deviceName: string): boolean {
  return /^Agent\s+AGENT-/i.test(deviceName.trim());
}

export function resolveDeviceTypeEditor(deviceName: string): {
  choice: DeviceTypeChoice;
  value: string;
} {
  const value = deviceName.trim();
  if (DEVICE_TYPE_PRESETS.includes(value as (typeof DEVICE_TYPE_PRESETS)[number])) {
    return { choice: value as (typeof DEVICE_TYPE_PRESETS)[number], value };
  }
  if (!value || isGeneratedAgentDeviceName(value)) {
    return { choice: DEFAULT_DEVICE_TYPE, value: DEFAULT_DEVICE_TYPE };
  }
  return { choice: "custom", value };
}

export function resolveDeviceTypeValue(choice: DeviceTypeChoice, customValue: string): string {
  return choice === "custom" ? customValue.trim() : choice;
}
