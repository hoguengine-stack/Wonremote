import type { DeviceGroup } from "./types";

export const VIEWER_LIST_STORAGE_KEY = "wonremote-viewer-list-v1";
export const GROUP_DRAG_TYPE = "application/x-wonremote-group";

export interface DeviceListPreferences {
  groupOrder: string[];
  knownDeviceIds: string[] | null;
  newDeviceIds: string[];
}

export function readDeviceListPreferences(value: string | null): DeviceListPreferences {
  try {
    const parsed = value ? JSON.parse(value) : null;
    const strings = (items: unknown): string[] => Array.isArray(items)
      ? [...new Set(items.filter((item): item is string => typeof item === "string" && item.length > 0))]
      : [];
    return {
      groupOrder: strings(parsed?.groupOrder),
      knownDeviceIds: Array.isArray(parsed?.knownDeviceIds) ? strings(parsed.knownDeviceIds) : null,
      newDeviceIds: strings(parsed?.newDeviceIds),
    };
  } catch {
    return { groupOrder: [], knownDeviceIds: null, newDeviceIds: [] };
  }
}

export function discoverNewDevices(preferences: DeviceListPreferences, deviceIds: string[]): DeviceListPreferences {
  if (preferences.knownDeviceIds === null) {
    return { ...preferences, knownDeviceIds: [...new Set(deviceIds)] };
  }
  const known = new Set(preferences.knownDeviceIds);
  const arrivals = deviceIds.filter((id) => !known.has(id));
  if (!arrivals.length) return preferences;
  return {
    ...preferences,
    knownDeviceIds: [...known, ...new Set(arrivals)],
    newDeviceIds: [...new Set([...preferences.newDeviceIds, ...arrivals])],
  };
}

export function acknowledgeNewDevice(preferences: DeviceListPreferences, deviceId: string): DeviceListPreferences {
  if (!preferences.newDeviceIds.includes(deviceId)) return preferences;
  return { ...preferences, newDeviceIds: preferences.newDeviceIds.filter((id) => id !== deviceId) };
}

export function orderStoreGroups(groups: DeviceGroup[], order: string[]): DeviceGroup[] {
  const ranks = new Map(order.map((name, index) => [name, index]));
  return [...groups].sort((left, right) => (ranks.get(left.storeName) ?? Infinity) - (ranks.get(right.storeName) ?? Infinity));
}

export function moveStoreGroup(names: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !names.includes(source) || !names.includes(target)) return names;
  const result = names.filter((name) => name !== source);
  result.splice(result.indexOf(target) + Number(after), 0, source);
  return result;
}

export function renameStoreGroup(order: string[], previous: string, next: string): string[] {
  if (previous === next || !order.includes(previous)) return order;
  return order.map((name) => name === previous ? next : name).filter((name, index, names) => names.indexOf(name) === index);
}
