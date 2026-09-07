import type { ManagedDevice } from "./types";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "./deviceDefaults";

export const DEVICE_DRAG_TYPE = "application/x-wonremote-device";

export function automaticDesktopName(value: string): string {
  const words = value.trim().split(/\s+/);
  for (let size = 1; size <= words.length / 2; size++) {
    if (words.length % size === 0 && words.every((word, i) => word.toLowerCase() === words[i % size].toLowerCase())) {
      return words.slice(0, size).join(" ");
    }
  }
  return value.trim();
}

export function organizeDevices(devices: ManagedDevice[]): ManagedDevice[] {
  const names = new Map<string, Set<string>>();
  const businessKey = (device: ManagedDevice) => device.businessNumber.replace(/\D/g, "");
  for (const device of devices) {
    const key = businessKey(device);
    const name = normalizeStoreNameForDisplay(device.storeName, device.businessNumber);
    if (key.length !== 10 || name === DEFAULT_STORE_NAME) continue;
    const stores = names.get(key) ?? new Set<string>();
    stores.add(name);
    names.set(key, stores);
  }
  return devices.map((device) => {
    const stores = names.get(businessKey(device));
    const storeName = normalizeStoreNameForDisplay(device.storeName, device.businessNumber);
    return {
      ...device,
      storeName: storeName === DEFAULT_STORE_NAME && stores?.size === 1 ? [...stores][0] : storeName,
      desktopName: device.desktopNameOverride || automaticDesktopName(device.desktopName),
    };
  });
}

export function createDeviceGroupMover(update: (id: string, input: { storeName: string }) => Promise<ManagedDevice>) {
  let busy = false;
  let disposed = false;
  let generation = 0;
  return {
    activate() { disposed = false; },
    dispose() { disposed = true; generation++; },
    async move(device: ManagedDevice, storeName: string): Promise<ManagedDevice | null> {
      if (disposed || busy || !storeName.trim() || device.storeName === storeName) return null;
      busy = true;
      const started = generation;
      try {
        const updated = await update(device.id, { storeName });
        return disposed || generation !== started ? null : updated;
      } catch (error) {
        if (disposed || generation !== started) return null;
        throw error;
      } finally { busy = false; }
    },
  };
}
