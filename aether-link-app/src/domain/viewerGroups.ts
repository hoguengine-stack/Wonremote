import { DEFAULT_DEVICE_TYPE } from "./deviceType";
import type { ManagedDevice } from "./types";

export interface ViewerGroup { id: string; name: string; parentId: string | null; deviceIds: string[] }

export interface ViewerGrouping { customGroups: ViewerGroup[]; groupOrder: string[] }

export function readViewerGrouping(value: { customGroups?: unknown; groupOrder?: unknown } = {}): ViewerGrouping {
  return {
    customGroups: readViewerGroups(value.customGroups),
    groupOrder: Array.isArray(value.groupOrder)
      ? [...new Set(value.groupOrder.filter((name): name is string => typeof name === "string" && !!name))].slice(0, 2000)
      : [],
  };
}

export function readViewerGroups(value: unknown): ViewerGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: ViewerGroup[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item.id !== "string" || !item.id || groups.some(g => g.id === item.id) || typeof item.name !== "string" || !item.name.trim()) continue;
    groups.push({id:item.id, name:item.name.trim().slice(0,100), parentId:typeof item.parentId === "string" ? item.parentId : null,
      deviceIds: Array.isArray(item.deviceIds) ? [...new Set<string>(item.deviceIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0))] : []});
  }
  for (const group of groups) {
    const seen = new Set([group.id]);
    let parent = group.parentId;
    while (parent) {
      const next = groups.find(g => g.id === parent);
      if (!next || seen.has(parent)) { group.parentId = null; break; }
      seen.add(parent); parent = next.parentId;
    }
  }
  return groups;
}

export function groupDeviceIds(groups: ViewerGroup[], id: string): Set<string> {
  const ids = new Set<string>();
  const visit = (parent: string) => {
    for (const device of groups.find(g => g.id === parent)?.deviceIds ?? []) ids.add(device);
    for (const child of groups.filter(g => g.parentId === parent)) visit(child.id);
  };
  visit(id);
  return ids;
}

export function saveViewerGroup(groups: ViewerGroup[], value: ViewerGroup): ViewerGroup[] {
  if (!groups.some(g=>g.id===value.id) && groups.length>=200) throw new Error("그룹은 최대 200개까지 만들 수 있습니다.");
  if (!value.name.trim() || value.name.trim().length > 100) throw new Error("그룹 이름은 1~100자로 입력해 주세요.");
  let parent = value.parentId;
  const seen = new Set([value.id]);
  while (parent) {
    if (seen.has(parent)) throw new Error("자신 또는 하위 그룹 안으로 이동할 수 없습니다.");
    seen.add(parent);
    const group = groups.find(g => g.id === parent);
    if (!group) throw new Error("상위 그룹을 찾을 수 없습니다.");
    parent = group.parentId;
  }
  const next = {...value, name:value.name.trim(), deviceIds:[...new Set(value.deviceIds)]};
  return groups.some(g => g.id === value.id) ? groups.map(g => g.id === value.id ? next : g) : [...groups, next];
}

export function applyViewerGroupEdit(groups: ViewerGroup[], original: ViewerGroup | null, draft: ViewerGroup): ViewerGroup[] {
  if (!original) return saveViewerGroup(groups, draft);
  const current = groups.find(group => group.id === original.id);
  if (!current) throw new Error("다른 Viewer에서 이 그룹을 삭제했습니다.");
  const applyField = <T,>(before: T, edited: T, saved: T): T => {
    if (edited === before) return saved;
    if (saved !== before && saved !== edited) throw new Error("다른 Viewer에서 같은 그룹 설정을 수정했습니다. 다시 열어 주세요.");
    return edited;
  };
  const before = new Set(original.deviceIds);
  const after = new Set(draft.deviceIds);
  return saveViewerGroup(groups, {...current,
    name: applyField(original.name, draft.name, current.name),
    parentId: applyField(original.parentId, draft.parentId, current.parentId),
    deviceIds: [...current.deviceIds.filter(id=>!before.has(id)||after.has(id)), ...draft.deviceIds.filter(id=>!before.has(id))],
  });
}

export function deleteViewerGroup(groups: ViewerGroup[], id: string): ViewerGroup[] {
  const parentId = groups.find(g => g.id === id)?.parentId ?? null;
  return groups.filter(g => g.id !== id).map(g => g.parentId === id ? {...g,parentId} : g);
}

export function ungroupedViewerDevices(devices: ManagedDevice[], groups: ViewerGroup[]): ManagedDevice[] {
  const grouped = new Set(groups.flatMap(group => group.deviceIds));
  return devices.filter(device => !grouped.has(device.id));
}

export function viewerInventoryBlocks(devices: ManagedDevice[], groups: ViewerGroup[], selected: string | null) {
  const candidates = selected ? groups.filter(group => group.id === selected) : groups.filter(group => !group.parentId);
  const byDevice = new Map<string, { group: ViewerGroup; devices: ManagedDevice[] }>();
  const byId = new Map(devices.map(device => [device.id, device]));
  const ranks = new Map(devices.map((device, index) => [device.id, index]));
  for (const group of candidates) {
    const members = [...groupDeviceIds(groups, group.id)].filter(id => !byDevice.has(id) && byId.has(id));
    const block = { group, devices: members.map(id => byId.get(id)!).sort((a, b) =>
      Number(b.deviceName === DEFAULT_DEVICE_TYPE) - Number(a.deviceName === DEFAULT_DEVICE_TYPE) || ranks.get(a.id)! - ranks.get(b.id)!) };
    for (const id of members) byDevice.set(id, block);
  }
  const shown = new Set<string>();
  return devices.flatMap<{ group?: ViewerGroup; devices: ManagedDevice[] }>(device => {
    const block = byDevice.get(device.id);
    if (!block) return [{ devices: [device] }];
    if (shown.has(block.group.id)) return [];
    shown.add(block.group.id);
    return [block];
  });
}
