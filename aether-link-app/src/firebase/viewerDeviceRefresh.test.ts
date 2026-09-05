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
    const result = fetchFirebaseDevices(env, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledOnce();
    const action = (vi.mocked(addDoc).mock.calls[0][1] as any).action;
    next({ docChanges: () => [{ type: "modified", doc: { id: "device-1", data: () => ({ ...record, heartbeatRequestId: action.split(" ")[1] }) } }] });
    expect((await result)[0]).toMatchObject({ status: "online", presenceMode: "manual" });
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledOnce(); expect(addDoc).toHaveBeenCalledOnce();
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
