import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  batch: {
    commit: vi.fn<() => Promise<void>>(async () => undefined),
    set: vi.fn(),
  },
  getDoc: vi.fn(async () => ({ exists: () => true, data: () => ({ status: "online" }) })),
  safeBatchSet: vi.fn((batch: { set: (...args: unknown[]) => unknown }, ref: unknown, data: unknown, options?: unknown) =>
    options === undefined ? batch.set(ref, data) : batch.set(ref, data, options)),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((root: { path?: string }, ...segments: string[]) => segments.length > 0
    ? { path: segments.join("/") }
    : { path: `${root.path}/command-auto` }),
  getDoc: state.getDoc,
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(() => state.batch),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => ({
    auth: { currentUser: { uid: "viewer-1" } },
    db: {},
    functions: {},
    storage: {},
  })),
}));

vi.mock("./firestoreWrite", () => ({
  safeAddDoc: vi.fn(),
  safeBatchSet: state.safeBatchSet,
  safeBatchUpdate: vi.fn(),
  safeSetDoc: vi.fn(),
  safeUpdateDoc: vi.fn(),
}));

describe("Viewer direct session start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits the connected session and start-stream command atomically", async () => {
    const { openFirebaseSession } = await import("./viewerFirebase");

    const result = await openFirebaseSession("device-1", {} as ImportMetaEnv);

    expect(result.session).toMatchObject({ deviceId: "device-1", state: "connected" });
    expect(state.safeBatchSet).toHaveBeenCalledTimes(2);
    expect(state.safeBatchSet.mock.calls[0][2]).toMatchObject({
      deviceId: "device-1",
      ownerUid: "viewer-1",
      state: "connected",
    });
    expect(state.safeBatchSet.mock.calls[1][2]).toMatchObject({
      action: `start-stream ${result.session.id}`,
      sessionId: result.session.id,
      state: "pending",
    });
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(state.getDoc).not.toHaveBeenCalled();
  });
});
