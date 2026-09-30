import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDoc, getDoc, getDocFromServer, getDocs, getDocsFromServer, onSnapshot, writeBatch } from "firebase/firestore";
import { fetchFirebaseDevices, openFirebaseSession, requestFirebaseSecureSession } from "./viewerFirebase";

const state = vi.hoisted(() => ({ set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./firebaseConfig", () => ({ resolveFirebaseConfig: () => ({ projectId: "test" }) }));
vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: () => ({ db: {}, auth: { currentUser: { uid: "viewer-1" } } }),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...parts: string[]) => parts.join("/")),
  doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join("/") || "commands/new", id: "new" })),
  getDoc: vi.fn(), getDocFromServer: vi.fn(), getDocs: vi.fn(), getDocsFromServer: vi.fn(), onSnapshot: vi.fn(),
  addDoc: vi.fn().mockResolvedValue({ id: "command" }),
  serverTimestamp: vi.fn(() => "server-time"), setDoc: vi.fn().mockResolvedValue(undefined),
  writeBatch: vi.fn(() => ({ set: state.set, commit: state.commit })),
}));
const device = (overrides = {}) => ({
  businessNumber: "123-45-67890", deviceNumber: "AGENT-TEST0001", desktopName: "PC", deviceName: "POS",
  storeName: "Store", status: "online", lastSeenAt: new Date().toISOString(), protocolVersion: 2, ...overrides,
});
const env: ImportMetaEnv = { ...import.meta.env, VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE: "direct" };

describe("fresh device reads without collection listeners", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("performs exactly 11 server list reads for login plus 10 refreshes, none on idle", async () => {
    vi.mocked(getDocsFromServer).mockResolvedValue({ docs: Array.from({ length: 10 }, (_, i) => ({
      id: `device-${i}`, data: () => device({ deviceNumber: `AGENT-${i}`, desktopName: `PC-${i}` }),
    })) } as any);
    for (let i = 0; i < 11; i++) expect(await fetchFirebaseDevices(env)).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledTimes(11);
    expect(getDocs).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("reads only the selected target once per connection, retaining protocol and offline rejection", async () => {
    vi.mocked(getDocFromServer).mockResolvedValue({ id: "device-1", exists: () => true, data: () => device() } as any);
    for (let i = 0; i < 10; i++) await openFirebaseSession("device-1", env);
    expect(getDocFromServer).toHaveBeenCalledTimes(10);
    expect(state.set).toHaveBeenCalledTimes(20);
    expect(getDoc).not.toHaveBeenCalled();
    expect(getDocsFromServer).not.toHaveBeenCalled();
    expect(getDocs).not.toHaveBeenCalled();
  });

  it("requests manual presence once and unsubscribes when the matching heartbeat arrives", async () => {
    const record = device({ presenceMode: "manual", lastSeenAt: "2020-01-01T00:00:00Z" });
    vi.mocked(getDocsFromServer).mockResolvedValue({ docs: [{ id: "device-1", data: () => record }] } as any);
    let next!: (snapshot: any) => void;
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((_query: unknown, callback: typeof next) => { next = callback; return stop; }) as any);
    const progress = vi.fn();
    const result = fetchFirebaseDevices(env, true, undefined, progress);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledWith(expect.any(Array), ["device-1"]);
    expect(addDoc).toHaveBeenCalledOnce();
    const action = (vi.mocked(addDoc).mock.calls[0][1] as any).action;
    next({ docChanges: () => [{ type: "modified", doc: { id: "device-1", data: () => ({ ...record, heartbeatRequestId: action.split(" ")[1] }) } }] });
    expect(progress.mock.lastCall?.[1]).toEqual([]);
    expect((await result)[0]).toMatchObject({ status: "online", presenceMode: "manual" });
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledOnce(); expect(addDoc).toHaveBeenCalledOnce();
  });

  it("checks known devices before the list read finishes and checks only new IDs afterward", async () => {
    const record = device({ presenceMode: "manual" });
    let finishRead!: (value: any) => void;
    vi.mocked(getDocsFromServer).mockReturnValue(new Promise(resolve => { finishRead = resolve; }) as any);
    let next!: (snapshot: any) => void;
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((_query: unknown, callback: typeof next) => { next = callback; return stop; }) as any);
    const progress = vi.fn();
    const known = { id: "device-1", ...record } as any;
    const result = fetchFirebaseDevices(env, true, undefined, progress, [known]);
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
    const requestId = (vi.mocked(addDoc).mock.calls[0][1] as any).action.split(" ")[1];
    next({ docChanges: () => [{ type: "modified", doc: { id: known.id, data: () => ({ ...record, heartbeatRequestId: requestId }) } }] });
    expect(progress.mock.lastCall?.[1]).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    finishRead({ docs: [
      { id: known.id, data: () => ({ ...record, desktopName: "Renamed" }) },
      { id: "new", data: () => ({ ...record, desktopName: "New PC" }) },
    ] });
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledTimes(2);
    expect(progress.mock.lastCall?.[0][0]).toMatchObject({ desktopName: "Renamed", status: "online" });
    expect(progress.mock.lastCall?.[1]).toEqual(["new"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).map(d => [d.id, d.status])).toEqual([[known.id, "online"], ["new", "offline"]]);
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels parallel checks without dispatching devices from a late list read", async () => {
    const record = device({ presenceMode: "manual" });
    let finishRead!: (value: any) => void;
    vi.mocked(getDocsFromServer).mockReturnValue(new Promise(resolve => { finishRead = resolve; }) as any);
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockReturnValue(stop);
    const abort = new AbortController();
    const result = fetchFirebaseDevices(env, true, abort.signal, undefined, [{ id: "old", ...record } as any]);
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledOnce();
    abort.abort();
    await rejected;
    finishRead({ docs: [{ id: "new", data: () => record }] });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(stop).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([openFirebaseSession, requestFirebaseSecureSession])("rejects unavailable or incompatible targets before issuing commands", async (connect) => {
    for (const data of [device({ status: "offline" }), device({ protocolVersion: 999 })]) {
      vi.mocked(getDocFromServer).mockResolvedValue({ id: "device-1", exists: () => true, data: () => data } as any);
      await expect(connect("device-1", env)).rejects.toThrow();
    }
    vi.mocked(getDocFromServer).mockRejectedValueOnce(new Error("Quota exceeded."));
    await expect(connect("device-1", env)).rejects.toThrow("Quota exceeded.");
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocFromServer).toHaveBeenCalledTimes(3);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(getDoc).not.toHaveBeenCalled();
  });
});
