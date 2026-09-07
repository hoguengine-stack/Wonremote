import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevice } from "./types";
import { createDeviceGroupMover, organizeDevices } from "./deviceOrganization";
import { registerAgentFirstRun, applyAgentHeartbeat, updateDeviceMetadata } from "./agentRegistry";

const device = (id: string, storeName = "상호명 미설정", businessNumber = "123-45-67890"): ManagedDevice => ({
  id, storeName, businessNumber, deviceNumber: id, deviceName: "태블릿", desktopName: "CTD-7000 CTD-7000", status: "offline", lastSeenAt: "",
});
afterEach(() => vi.useRealTimers());
describe("device organization", () => {
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
