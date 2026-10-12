import type { DeviceGroup, ManagedDevice } from "./types";
import { readViewerGroups, type ViewerGroup } from "./viewerGroups";

export const VIEWER_LIST_STORAGE_KEY = "wonremote-viewer-list-v1";
export const GROUP_DRAG_TYPE = "application/x-wonremote-group";

export interface DeviceListPreferences {
  groupOrder: string[];
  knownDeviceIds: string[] | null;
  newDeviceIds: string[];
  baselineAt?: string;
  customGroups?: ViewerGroup[];
}

export function readDeviceListPreferences(value: string | null): DeviceListPreferences {
  try {
    const parsed = value ? JSON.parse(value) : null;
    const strings = (items: unknown): string[] => Array.isArray(items)
      ? [...new Set(items.filter((item): item is string => typeof item === "string" && item.length > 0))]
      : [];
    const baselineAt = typeof parsed?.baselineAt === "string" && Number.isFinite(Date.parse(parsed.baselineAt))
      ? parsed.baselineAt : undefined;
    return {
      groupOrder: strings(parsed?.groupOrder),
      knownDeviceIds: baselineAt && Array.isArray(parsed?.knownDeviceIds) ? strings(parsed.knownDeviceIds) : null,
      newDeviceIds: baselineAt ? strings(parsed?.newDeviceIds) : [],
      ...(baselineAt ? { baselineAt } : {}),
      ...(Array.isArray(parsed?.customGroups) ? {customGroups:readViewerGroups(parsed.customGroups)} : {}),
    };
  } catch {
    return { groupOrder: [], knownDeviceIds: null, newDeviceIds: [] };
  }
}

export function discoverNewDevices(preferences: DeviceListPreferences, devices: ManagedDevice[], nowIso = new Date().toISOString()): DeviceListPreferences {
  const deviceIds = devices.map(device => device.id);
  if (preferences.knownDeviceIds === null) {
    return { ...preferences, knownDeviceIds: [...new Set(deviceIds)], newDeviceIds: [], baselineAt: nowIso };
  }
  const known = new Set(preferences.knownDeviceIds);
  const arrivals = deviceIds.filter((id) => !known.has(id));
  if (!arrivals.length) return preferences;
  const newIds = devices.filter(device => {
    const registeredAt = Date.parse(device.firstRegisteredAt ?? "");
    return !known.has(device.id) && registeredAt > Date.parse(preferences.baselineAt ?? "") && registeredAt <= Date.parse(nowIso);
  }).map(device => device.id);
  return {
    ...preferences,
    knownDeviceIds: [...known, ...new Set(arrivals)],
    newDeviceIds: [...new Set([...preferences.newDeviceIds, ...newIds])],
  };
}

export function acknowledgeNewDevice(preferences: DeviceListPreferences, deviceId: string): DeviceListPreferences {
  if (!preferences.newDeviceIds.includes(deviceId)) return preferences;
  return { ...preferences, newDeviceIds: preferences.newDeviceIds.filter((id) => id !== deviceId) };
}

export function orderStoreGroups(groups: DeviceGroup[], order: string[], newDeviceIds: string[] = []): DeviceGroup[] {
  const ranks = new Map(order.map((name, index) => [name, index]));
  const newIds = new Set(newDeviceIds);
  const hasNew = (group: DeviceGroup) => group.devices.some(device => newIds.has(device.id));
  return [...groups].sort((left, right) => Number(hasNew(right)) - Number(hasNew(left)) || (ranks.get(left.storeName) ?? Infinity) - (ranks.get(right.storeName) ?? Infinity));
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
