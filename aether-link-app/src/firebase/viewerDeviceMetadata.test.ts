import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDoc, getDoc, updateDoc } from "firebase/firestore";
import { requestFirebaseAgentUpdate, updateFirebaseDeviceMetadata } from "./viewerFirebase";
import { createDeviceGroupMover } from "../domain/deviceOrganization";

const state = vi.hoisted(() => ({data: {} as Record<string, unknown>}));
vi.mock("./firebaseServices", () => ({getWonRemoteFirebaseServices: () => ({auth:{currentUser:{uid:"viewer"}},db:{}})}));
vi.mock("firebase/firestore", async (original) => ({
  ...await original<typeof import("firebase/firestore")>(),
  doc: vi.fn((_db, _collection, id) => ({id})),
  collection: vi.fn((...parts) => parts.slice(1).join("/")),
  addDoc: vi.fn(async () => ({id:"command"})),
  getDoc: vi.fn(async (ref) => ({id:ref.id, exists:()=>true, data:()=>({...state.data})})),
  updateDoc: vi.fn(async (_ref, patch) => { Object.assign(state.data, patch); }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.data = {businessNumber:"123-45-67890",deviceNumber:"AGENT-1",deviceName:"Android",desktopName:"CTD-7000 CTD-7000",storeName:"상호명 미설정"};
});
describe("Viewer metadata request boundary", () => {
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
  it("quota failure causes one failed write and no retry or readback", async () => {
    vi.mocked(updateDoc).mockRejectedValueOnce(new Error("resource-exhausted"));
    await expect(updateFirebaseDeviceMetadata("device",{storeName:"매장 A"})).rejects.toThrow("resource-exhausted");
    expect(getDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledTimes(1);
  });
});
