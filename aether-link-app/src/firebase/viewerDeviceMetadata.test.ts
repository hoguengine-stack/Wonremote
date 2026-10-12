import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDoc, deleteField, getDoc, getDocFromServer, updateDoc, writeBatch } from "firebase/firestore";
import { signInWithEmailAndPassword } from "firebase/auth";
import { fetchFirebaseAgentDevice, updateFirebaseAgentDevice, requestFirebaseAgentUpdate, updateFirebaseDeviceMetadata } from "./viewerFirebase";
import { createDeviceGroupMover } from "../domain/deviceOrganization";

const state = vi.hoisted(() => ({data: {} as Record<string, unknown>, patches: [] as any[], sets: [] as any[], failBatch: false}));
vi.mock("./firebaseServices", () => ({getWonRemoteFirebaseServices: () => ({auth:{currentUser:{uid:"viewer"}},db:{}})}));
vi.mock("firebase/auth", async original => ({...await original<typeof import("firebase/auth")>(), signInWithEmailAndPassword: vi.fn(async () => ({user:{uid:"agent-owner"}}))}));
vi.mock("firebase/firestore", async (original) => ({
  ...await original<typeof import("firebase/firestore")>(),
  doc: vi.fn((_db, _collection, id) => ({id})),
  collection: vi.fn((...parts) => parts.slice(1).join("/")),
  addDoc: vi.fn(async () => ({id:"command"})),
  getDoc: vi.fn(async (ref) => ({id:ref.id, exists:()=>true, data:()=>({...state.data})})),
  getDocFromServer: vi.fn(async (ref) => ({id:ref.id, exists:()=>true, data:()=>({...state.data})})),
  updateDoc: vi.fn(async (_ref, patch) => { Object.assign(state.data, patch); }),
  writeBatch: vi.fn(() => ({
    update: (_ref: unknown, patch: unknown) => state.patches.push(patch),
    set: (_ref: unknown, value: unknown) => state.sets.push(value),
    commit: async () => { if (state.failBatch) throw new Error("permission-denied"); state.patches.forEach(patch => Object.assign(state.data, patch)); },
  })),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.patches = []; state.sets = []; state.failBatch = false;
  state.data = {businessNumber:"123-45-67890",deviceNumber:"AGENT-1",deviceName:"Android",desktopName:"CTD-7000 CTD-7000",storeName:"상호명 미설정"};
});
describe("Viewer metadata request boundary", () => {
  it("running Agent edits only its own metadata using original auth and existing sync", async () => {
    state.data.ownerUid = "agent-owner"; state.data.installId = "1";
    const config={registeredDeviceId:"device",installId:"1",businessNumber:"987-65-43210",authBusinessNumber:"123-45-67890"};
    expect((await fetchFirebaseAgentDevice(config)).id).toBe("device");
    vi.clearAllMocks();
    const result=await updateFirebaseAgentDevice(config,{businessNumber:"1112233333",storeName:"수정 매장",deviceName:"오더포스",ownerUid:"attacker",updatePaused:true} as any);
    expect(result).toMatchObject({id:"device",businessNumber:"111-22-33333",storeName:"수정 매장",deviceName:"오더포스"});
    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(expect.anything(),"1234567890@agents.wonremote.app",expect.any(String));
    expect(getDocFromServer).toHaveBeenCalledOnce(); expect(getDoc).toHaveBeenCalledTimes(2);
    expect(state.data).toMatchObject({ownerUid:"agent-owner",installId:"1",deviceNumber:"AGENT-1"});
    expect(state.data).not.toHaveProperty("updatePaused");
    expect(state.sets).toEqual([expect.objectContaining({action:"sync-business-number"})]);
    await updateFirebaseAgentDevice(config,{businessNumber:"111-22-33333",storeName:"수정 매장",deviceName:"오더포스"});
    expect(state.sets).toHaveLength(1);
  });
  it("denies wrong-owner/install, invalid values and failed Agent saves without retries", async () => {
    const config={registeredDeviceId:"device",installId:"1",businessNumber:"123-45-67890"};
    const input={businessNumber:"9876543210",storeName:"매장",deviceName:"메인포스"};
    state.data.ownerUid="someone-else";state.data.installId="1";
    await expect(updateFirebaseAgentDevice(config,input)).rejects.toThrow("이 Agent");
    state.data.ownerUid="agent-owner";state.data.installId="other-install";
    await expect(updateFirebaseAgentDevice(config,input)).rejects.toThrow("이 Agent");
    expect(writeBatch).not.toHaveBeenCalled();expect(updateDoc).not.toHaveBeenCalled();
    await expect(updateFirebaseAgentDevice(config,{...input,businessNumber:"123"})).rejects.toThrow("10");
    await expect(updateFirebaseAgentDevice(config,{...input,deviceName:"a".repeat(101)})).rejects.toThrow("길이");
    state.data.installId="1";state.failBatch=true;
    await expect(updateFirebaseAgentDevice(config,input)).rejects.toThrow("permission-denied");
    expect(state.data.businessNumber).toBe("123-45-67890");expect(writeBatch).toHaveBeenCalledOnce();
  });
  it("atomically stores a ZOOK number with one command, preserves zeroes and avoids unchanged repeats", async () => {
    const result = await updateFirebaseDeviceMetadata("device", {zookNumber:"00123456"});
    expect(result.zookNumber).toBe("00123456");
    expect(state.sets).toEqual([expect.objectContaining({action:"configure-zook",state:"pending"})]);
    expect(getDoc).toHaveBeenCalledTimes(2);
    expect(writeBatch).toHaveBeenCalledOnce();
    await updateFirebaseDeviceMetadata("device",{zookNumber:"00123456"});
    expect(state.sets).toHaveLength(1);
    const before = {...state.data};
    await expect(updateFirebaseDeviceMetadata("device",{zookNumber:"1234abcd"})).rejects.toThrow("8");
    expect(state.data).toEqual(before);
    state.failBatch=true;
    await expect(updateFirebaseDeviceMetadata("device",{zookNumber:"87654321"})).rejects.toThrow("permission-denied");
    expect(state.data.zookNumber).toBe("00123456");
  });
  it("atomically changes the business number and queues one sync without changing identity", async () => {
    state.data.ownerUid = "agent-owner"; state.data.installId = "1";
    const result = await updateFirebaseDeviceMetadata("device", {businessNumber:"9876543210"});
    expect(result).toMatchObject({id:"device",businessNumber:"987-65-43210"});
    expect(state.data).toMatchObject({ownerUid:"agent-owner",installId:"1",deviceNumber:"AGENT-1"});
    expect(state.sets).toEqual([expect.objectContaining({action:"sync-business-number",state:"pending"})]);
    expect(getDoc).toHaveBeenCalledTimes(2); expect(writeBatch).toHaveBeenCalledOnce();
    expect(updateDoc).not.toHaveBeenCalled(); expect(addDoc).not.toHaveBeenCalled();
    await updateFirebaseDeviceMetadata("device", {businessNumber:"987-65-43210"});
    expect(writeBatch).toHaveBeenCalledOnce(); expect(state.sets).toHaveLength(1);
  });
  it("rejects invalid numbers and failed batches without partial business-number updates", async () => {
    await expect(updateFirebaseDeviceMetadata("device", {businessNumber:"123"})).rejects.toThrow("10");
    expect(writeBatch).not.toHaveBeenCalled(); expect(updateDoc).not.toHaveBeenCalled();
    state.failBatch = true;
    await expect(updateFirebaseDeviceMetadata("device", {businessNumber:"987-65-43210"})).rejects.toThrow("permission-denied");
    expect(state.data.businessNumber).toBe("123-45-67890");
    expect(writeBatch).toHaveBeenCalledOnce(); expect(getDoc).toHaveBeenCalledTimes(2);
  });
  it("sends one update command without readback, polling or automatic quota retries", async () => {
    await requestFirebaseAgentUpdate("device");
    expect(addDoc).toHaveBeenCalledWith("devices/device/commands", expect.objectContaining({action:expect.stringMatching(/^request-update \d{13}$/),state:"pending"}));
    expect(getDoc).not.toHaveBeenCalled();
    expect(addDoc).toHaveBeenCalledTimes(1);
    vi.mocked(addDoc).mockRejectedValueOnce(new Error("resource-exhausted"));
    await expect(requestFirebaseAgentUpdate("device")).rejects.toThrow("resource-exhausted");
    expect(addDoc).toHaveBeenCalledTimes(2);
  });
  it("persists the desktop override without changing Agent-reported desktopName", async () => {
    const result = await updateFirebaseDeviceMetadata("device", {desktopName:"테이블 1",deviceName:"태블릿"});
    expect(result).toMatchObject({desktopName:"테이블 1",deviceName:"태블릿"});
    expect(state.data.desktopName).toBe("CTD-7000 CTD-7000");
    expect(state.data.desktopNameOverride).toBe("테이블 1");
    expect(getDoc).toHaveBeenCalledTimes(2);
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
  it("20 explicit daily drops cost 40 document reads and 20 writes; no hidden requests", async () => {
    const mover = createDeviceGroupMover(updateFirebaseDeviceMetadata);
    for(let i=0; i<20; i++) await mover.move({id:"device",storeName:"상호명 미설정"} as never,"매장 A");
    expect(getDoc).toHaveBeenCalledTimes(40);
    expect(updateDoc).toHaveBeenCalledTimes(20);
    expect(state.data.businessNumber).toBe("123-45-67890");
    expect(state.data.storeName).toBe("매장 A");
  });
  it("saves a bounded phone through the existing metadata request and preserves omitted phone", async () => {
    const result = await updateFirebaseDeviceMetadata("device", { contactPhone: `  ${"1".repeat(50)}  ` });
    expect(result.contactPhone).toBe("1".repeat(40));
    expect(getDoc).toHaveBeenCalledTimes(2);
    expect(updateDoc).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    const renamed = await updateFirebaseDeviceMetadata("device", { deviceName: "Tablet" });
    expect(renamed.contactPhone).toBe("1".repeat(40));
    expect(vi.mocked(updateDoc).mock.calls[0][1]).not.toHaveProperty("contactPhone");
    expect(getDoc).toHaveBeenCalledTimes(2);
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
  it("clears a phone with a delete transform and does not retry a rejected phone write", async () => {
    state.data.contactPhone = "010-1234-5678";
    await updateFirebaseDeviceMetadata("device", { contactPhone: "  " });
    expect(updateDoc).toHaveBeenCalledWith({ id: "device" }, expect.objectContaining({ contactPhone: deleteField() }));
    expect(getDoc).toHaveBeenCalledTimes(2);
    expect(updateDoc).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    vi.mocked(updateDoc).mockRejectedValueOnce(new Error("permission-denied"));
    await expect(updateFirebaseDeviceMetadata("device", { contactPhone: "010-9999-8888" })).rejects.toThrow("permission-denied");
    expect(getDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
  it("quota failure causes one failed write and no retry or readback", async () => {
    vi.mocked(updateDoc).mockRejectedValueOnce(new Error("resource-exhausted"));
    await expect(updateFirebaseDeviceMetadata("device",{storeName:"매장 A"})).rejects.toThrow("resource-exhausted");
    expect(getDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
});
