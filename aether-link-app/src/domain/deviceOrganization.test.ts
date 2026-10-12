import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevice } from "./types";
import { createDeviceGroupMover, organizeDevices } from "./deviceOrganization";
import {
  acknowledgeNewDevice,
  discoverNewDevices,
  moveStoreGroup,
  orderStoreGroups,
  readDeviceListPreferences,
  renameStoreGroup,
} from "./deviceListPreferences";
import { registerAgentFirstRun, applyAgentHeartbeat, updateDeviceMetadata } from "./agentRegistry";
import { readViewerGroups, saveViewerGroup, deleteViewerGroup, groupDeviceIds } from "./viewerGroups";

const device = (id: string, storeName = "상호명 미설정", businessNumber = "123-45-67890"): ManagedDevice => ({
  id, storeName, businessNumber, deviceNumber: id, deviceName: "태블릿", desktopName: "CTD-7000 CTD-7000", status: "offline", lastSeenAt: "",
});
afterEach(() => vi.useRealTimers());
describe("device organization", () => {
  it("creates nested groups across businesses, roundtrips membership and prevents cycles without changing devices", () => {
    let groups = saveViewerGroup([], {id:"root",name:"대그룹",parentId:null,deviceIds:["a"]});
    groups = saveViewerGroup(groups,{id:"child",name:"매장",parentId:"root",deviceIds:["b"]});
    groups = saveViewerGroup(groups,{id:"leaf",name:"단말",parentId:"child",deviceIds:["c","c"]});
    expect([...groupDeviceIds(groups,"root")]).toEqual(["a","b","c"]);
    expect(readDeviceListPreferences(JSON.stringify({customGroups:groups})).customGroups).toEqual(groups);
    expect(()=>saveViewerGroup(groups,{...groups[0],parentId:"leaf"})).toThrow("하위");
    expect(deleteViewerGroup(groups,"child").find(g=>g.id==="leaf")?.parentId).toBe("root");
    expect(readViewerGroups([{id:"a",name:"A",parentId:"b"},{id:"b",name:"B",parentId:"a"}]).filter(g=>g.parentId===null).length).toBeGreaterThan(0);
    expect(readViewerGroups([{id:"a",name:"A",deviceIds:[1,"x","x"]}])[0].deviceIds).toEqual(["x"]);
    expect(orderStoreGroups([{storeName:"old",devices:[device("old")]},{storeName:"new",devices:[device("new")]}],["old","new"],["new"])[0].storeName).toBe("new");
  });
  it("carries first-run store/type/notes and preserves edits during re-registration", () => {
    const input={businessNumber:"1234567890",password:"1234",installId:"initial",storeName:"상호",deviceName:"오더포스",notes:"설치 메모"};
    const initial=registerAgentFirstRun([],input);
    expect(initial.device).toMatchObject({storeName:"상호",storeNameSource:"user",deviceName:"오더포스",notes:"설치 메모"});
    const edited=updateDeviceMetadata(initial.devices,{deviceId:initial.device.id,storeName:"수정 상호",deviceName:"키오스크",notes:"운영 메모"});
    expect(registerAgentFirstRun(edited.devices,input).device).toMatchObject({storeName:"수정 상호",deviceName:"키오스크",notes:"운영 메모"});
    expect(()=>registerAgentFirstRun([],{...input,notes:"x".repeat(2001)})).toThrow("길이");
  });
  it("baselines existing devices and keeps a new device marked until acknowledged", () => {
    const initial = readDeviceListPreferences(null);
    const baseline = discoverNewDevices(initial, [device("old")], "2026-10-09T00:00:00Z");
    expect(baseline.newDeviceIds).toEqual([]);
    const devices = [device("old"), {...device("new"), firstRegisteredAt:"2026-10-09T00:00:01Z"}, device("old-unseen")];
    const discovered = discoverNewDevices(baseline, devices, "2026-10-09T00:00:02Z");
    expect(discovered.newDeviceIds).toEqual(["new"]);
    expect(discoverNewDevices(discovered, devices)).toBe(discovered);
    expect(acknowledgeNewDevice(discovered, "new").newDeviceIds).toEqual([]);
    expect(discoverNewDevices(acknowledgeNewDevice(discovered, "new"), devices).newDeviceIds).toEqual([]);
    expect(readDeviceListPreferences(JSON.stringify(discovered))).toEqual(discovered);
  });
  it("never renews first registration on local re-registration or backfills legacy devices", () => {
    const input={businessNumber:"1234567890",password:"1234",installId:"initial"};
    const initial=registerAgentFirstRun([],input,"2026-10-08T00:00:00Z");
    expect(initial.device.firstRegisteredAt).toBe("2026-10-08T00:00:00Z");
    expect(registerAgentFirstRun(initial.devices,input,"2026-10-09T00:00:00Z").device.firstRegisteredAt).toBe(initial.device.firstRegisteredAt);
    const legacy={...initial.device}; delete legacy.firstRegisteredAt;
    expect(registerAgentFirstRun([legacy],input,"2026-10-09T00:00:00Z").device.firstRegisteredAt).toBeUndefined();
  });
  it("does not infer NEW from heartbeat time, old, missing, invalid or future registration times", () => {
    const baseline=discoverNewDevices(readDeviceListPreferences(null),[],"2026-10-09T00:00:00Z");
    const loaded=[undefined,"invalid","2026-10-08T00:00:00Z","2026-10-10T00:00:00Z"].map((firstRegisteredAt,i)=>({...device(String(i)),firstRegisteredAt,lastSeenAt:"2026-10-09T00:00:01Z"}));
    const result=discoverNewDevices(baseline,loaded,"2026-10-09T00:00:02Z");
    expect(result.newDeviceIds).toEqual([]);
    expect(result.knownDeviceIds).toEqual(["0","1","2","3"]);
  });
  it("repairs ambiguous legacy NEW flags without discarding saved groups", () => {
    const prefs = readDeviceListPreferences(JSON.stringify({groupOrder:["B","A"],knownDeviceIds:["old"],newDeviceIds:["old"],customGroups:[{id:"g",name:"Group",parentId:null,deviceIds:["old"]}]}));
    expect(prefs.knownDeviceIds).toBeNull();
    expect(prefs.newDeviceIds).toEqual([]);
    expect(prefs.groupOrder).toEqual(["B","A"]);
    expect(prefs.customGroups?.[0].deviceIds).toEqual(["old"]);
  });
  it("persists group order while appending new groups and preserving renamed positions", () => {
    const names = ["A", "B", "C"];
    const reordered = moveStoreGroup(names, "C", "A", false);
    expect(reordered).toEqual(["C", "A", "B"]);
    expect(moveStoreGroup(names, "A", "A", false)).toBe(names);
    const renamed = renameStoreGroup(reordered, "C", "Z");
    const groups = ["A", "B", "Z", "D"].map((storeName) => ({ storeName, devices: [] }));
    expect(orderStoreGroups(groups, renamed).map((group) => group.storeName)).toEqual(["Z", "A", "B", "D"]);
  });
  it("ignores malformed stored preferences", () => {
    expect(readDeviceListPreferences("not-json")).toEqual({ groupOrder: [], knownDeviceIds: null, newDeviceIds: [] });
  });
  it("groups newly loaded same-business tablets without changing explicit names or raw state", () => {
    const source = [device("pos", "매장 A"), device("tablet"), device("other", "매장 B", "999-99-99999")];
    const result = organizeDevices(source);
    expect(result[1]).toMatchObject({storeName:"매장 A", desktopName:"CTD-7000"});
    expect(source[1].storeName).toBe("상호명 미설정");
    expect(result[2].storeName).toBe("매장 B");
    expect(organizeDevices([device("a", "A"), device("b", "B"), device("c")])[2].storeName).toBe("상호명 미설정");
  });
  it("preserves custom names on registration and local heartbeat", () => {
    const input = {businessNumber:"1234567890", password:"1234", installId:"12345678", desktopName:"CTD-7000 CTD-7000"};
    const registered = registerAgentFirstRun([], input);
    const edited = updateDeviceMetadata(registered.devices, {deviceId:registered.device.id, desktopName:"테이블 1", deviceName:"태블릿"});
    const renewed = registerAgentFirstRun(edited.devices, input);
    const heartbeat = applyAgentHeartbeat(renewed.devices, {deviceId:registered.device.id, installId:input.installId, desktopName:"AUTOMATIC"});
    expect(organizeDevices(heartbeat.devices)[0].desktopName).toBe("테이블 1");
    expect(organizeDevices([{...device("custom"),desktopNameOverride:"CTD-7000 CTD-7000"}])[0].desktopName).toBe("CTD-7000 CTD-7000");
  });
  it("copies only store name through a single persisted metadata action", async () => {
    const current = device("tablet");
    const update = vi.fn(async (id: string, input: {storeName: string}) => updateDeviceMetadata([current], {deviceId:id,...input}).device);
    const mover = createDeviceGroupMover(update);
    const moved = await mover.move(current, "매장 B");
    expect(update).toHaveBeenCalledExactlyOnceWith("tablet", {storeName:"매장 B"});
    expect(moved).toMatchObject({storeName:"매장 B", storeNameSource:"user", businessNumber:current.businessNumber});
    expect(organizeDevices([moved!,device("next")])[1].storeName).toBe("매장 B");
  });
  it("has zero 24h idle actions; 20 deliberate moves use 20 updates without retries", async () => {
    vi.useFakeTimers();
    const update = vi.fn(async (id: string, input: {storeName: string}) => device(id,input.storeName));
    const mover = createDeviceGroupMover(update);
    for (let i=0; i<100; i++) organizeDevices([device("a","매장"),device("b")]);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(update).not.toHaveBeenCalled();
    for (let i=0; i<20; i++) await mover.move(device("a"),"매장");
    expect(update).toHaveBeenCalledTimes(20);
  });
  it("blocks overlapping writes, propagates quota failures once, and ignores completion after logout", async () => {
    let finish!: (value: ManagedDevice) => void;
    const update = vi.fn(() => new Promise<ManagedDevice>(resolve => { finish=resolve; }));
    const mover = createDeviceGroupMover(update);
    const first = mover.move(device("a"),"매장");
    expect(await mover.move(device("a"),"매장")).toBeNull();
    mover.dispose(); mover.activate(); finish(device("a","매장"));
    expect(await first).toBeNull();
    update.mockRejectedValueOnce(new Error("resource-exhausted"));
    await expect(mover.move(device("a"),"매장")).rejects.toThrow("resource-exhausted");
    expect(update).toHaveBeenCalledTimes(2);
    mover.dispose(); expect(await mover.move(device("a"),"매장")).toBeNull();
  });
});
