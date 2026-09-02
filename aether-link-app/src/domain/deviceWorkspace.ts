import type { ManagedDevice } from "./types";

export type DeviceWorkspaceStatusFilter = "all" | "online" | "offline" | "update-attention";

export interface DeviceWorkspaceFilters {
  status?: DeviceWorkspaceStatusFilter;
  query?: string;
  selectedStore?: string;
  favoriteOnly?: boolean;
  favoriteDeviceIds?: Iterable<string>;
}

const NO_STORE_FILTER = "전체";
const UPDATE_ATTENTION_STATES = new Set(["available", "required", "outdated", "pending", "failed", "rollback"]);

export function filterDeviceWorkspace(
  devices: readonly ManagedDevice[],
  filters: DeviceWorkspaceFilters = {},
): ManagedDevice[] {
  const favoriteIds = normalizeIdSet(filters.favoriteDeviceIds);
  const term = filters.query?.trim().toLocaleLowerCase() ?? "";
  const selectedStore = filters.selectedStore?.trim() ?? "";
  const status = filters.status ?? "all";

  const filtered = devices.filter((device) => {
    if (status === "online" && device.status !== "online") {
      return false;
    }
    if (status === "offline" && device.status !== "offline") {
      return false;
    }
    if (status === "update-attention" && !hasUpdateAttention(device)) {
      return false;
    }
    if (selectedStore && selectedStore !== NO_STORE_FILTER && device.storeName !== selectedStore) {
      return false;
    }
    if (filters.favoriteOnly && !favoriteIds.has(device.id)) {
      return false;
    }
    if (term) {
      const searchable = [
        device.businessNumber,
        device.storeName,
        device.deviceNumber,
        device.deviceName,
        device.desktopName,
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (!searchable.includes(term)) {
        return false;
      }
    }
    return true;
  });

  return sortDeviceWorkspace(filtered, favoriteIds);
}

export function sortDeviceWorkspace(
  devices: readonly ManagedDevice[],
  favoriteDeviceIds: Iterable<string> = [],
): ManagedDevice[] {
  const favoriteIds = normalizeIdSet(favoriteDeviceIds);
  return [...devices].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "online" ? -1 : 1;
    }

    const favoriteCompare = Number(favoriteIds.has(right.id)) - Number(favoriteIds.has(left.id));
    if (favoriteCompare !== 0) {
      return favoriteCompare;
    }

    const desktopNameCompare = left.desktopName.localeCompare(right.desktopName, "ko", {
      numeric: true,
      sensitivity: "base",
    });
    return desktopNameCompare !== 0 ? desktopNameCompare : left.id.localeCompare(right.id, "ko");
  });
}

export function serializeFavoriteDeviceIds(ids: Iterable<string> | null | undefined): string {
  return JSON.stringify(normalizeIds(ids));
}

export function parseFavoriteDeviceIds(value: string | null | undefined): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeIds(parsed) : [];
  } catch {
    return [];
  }
}

export function pruneSelectedDeviceIds(
  selectedIds: Iterable<string> | null | undefined,
  devices: readonly Pick<ManagedDevice, "id">[],
): string[] {
  const currentIds = new Set(normalizeIds(devices.map((device) => device.id)));
  return normalizeIds(selectedIds).filter((id) => currentIds.has(id));
}

function hasUpdateAttention(device: ManagedDevice): boolean {
  const candidate = device as ManagedDevice & Record<string, unknown>;
  const state = [candidate.updateState, candidate.updateStatus]
    .find((value): value is string => typeof value === "string")
    ?.trim()
    .toLowerCase();
  return candidate.updateAvailable === true || UPDATE_ATTENTION_STATES.has(state ?? "");
}

function normalizeIdSet(ids: Iterable<string> | null | undefined): Set<string> {
  return new Set(normalizeIds(ids));
}

function normalizeIds(ids: Iterable<unknown> | null | undefined): string[] {
  if (!ids) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    if (typeof value !== "string") {
      continue;
    }
    const id = value.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}
