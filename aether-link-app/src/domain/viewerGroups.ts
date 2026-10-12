export interface ViewerGroup { id: string; name: string; parentId: string | null; deviceIds: string[] }

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

export function deleteViewerGroup(groups: ViewerGroup[], id: string): ViewerGroup[] {
  const parentId = groups.find(g => g.id === id)?.parentId ?? null;
  return groups.filter(g => g.id !== id).map(g => g.parentId === id ? {...g,parentId} : g);
}
