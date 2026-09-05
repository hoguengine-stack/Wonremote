export interface DeviceViewPreferences {
  clipboardSync: boolean;
  fullscreen: boolean;
  selectedDisplayIndex: number;
  zoom: number;
}

export const DEFAULT_DEVICE_VIEW_PREFERENCES: DeviceViewPreferences = {
  clipboardSync: false,
  fullscreen: false,
  selectedDisplayIndex: 0,
  zoom: 1,
};

export function deviceViewPreferencesKey(deviceId: string): string {
  return `wonremote-device-view:${deviceId}`;
}

export function parseDeviceViewPreferences(value: string | null): DeviceViewPreferences {
  if (!value) return DEFAULT_DEVICE_VIEW_PREFERENCES;
  try {
    const parsed = JSON.parse(value) as Partial<DeviceViewPreferences>;
    return {
      clipboardSync: parsed.clipboardSync === true,
      fullscreen: parsed.fullscreen === true,
      selectedDisplayIndex: Number.isInteger(parsed.selectedDisplayIndex) && parsed.selectedDisplayIndex! >= 0
        ? parsed.selectedDisplayIndex!
        : 0,
      zoom: typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom)
        ? Math.max(0.25, Math.min(8, parsed.zoom))
        : 1,
    };
  } catch {
    return DEFAULT_DEVICE_VIEW_PREFERENCES;
  }
}
