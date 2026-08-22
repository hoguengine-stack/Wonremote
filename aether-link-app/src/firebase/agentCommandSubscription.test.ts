import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDoc, onSnapshot, writeBatch } from "firebase/firestore";
import { subscribeAgentCommandsWithFirebase } from "./agentFirebase";
import { sendAgentHeartbeatWithFirebase } from "./agentFirebase";

const state = vi.hoisted(() => ({
  services: { auth: { currentUser: { uid: "agent-uid" } }, db: {} },
  snapshotHandler: undefined as ((snapshot: any) => void) | undefined,
  errorHandler: undefined as ((error: unknown) => void) | undefined,
  unsubscribe: vi.fn(),
  batch: { commit: vi.fn(async () => undefined), update: vi.fn() },
  update: vi.fn(async () => undefined),
}));

vi.mock("./firebaseConfig", () => ({
  resolveFirebaseConfig: vi.fn(() => ({ apiKey: "key", appId: "app", authDomain: "test", projectId: "project" })),
}));
vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => state.services),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  getDoc: vi.fn(async () => ({ exists: () => true, data: () => ({ installId: "install-1" }) })),
  getDocs: vi.fn(),
  limit: vi.fn((value: number) => ({ limit: value })),
  onSnapshot: vi.fn((_query: unknown, onNext: (snapshot: any) => void, onError: (error: unknown) => void) => {
    state.snapshotHandler = onNext;
    state.errorHandler = onError;
    return state.unsubscribe;
  }),
  orderBy: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(() => state.batch),
}));
vi.mock("./firestoreWrite", () => ({
  safeBatchUpdate: vi.fn((batch: any, ref: unknown, data: unknown) => batch.update(ref, data)),
  safeAddDoc: vi.fn(),
  safeSetDoc: vi.fn(),
  safeUpdateDoc: vi.fn(),
}));
vi.mock("firebase/auth", () => ({ createUserWithEmailAndPassword: vi.fn(), signInWithEmailAndPassword: vi.fn() }));
vi.mock("firebase/storage", () => ({ getDownloadURL: vi.fn(), ref: vi.fn() }));

describe("Agent Firebase command subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshotHandler = undefined;
    state.errorHandler = undefined;
    state.batch.commit.mockClear();
    state.update.mockClear();
  });

  it("validates the device once and delivers pending commands after marking them delivered", async () => {
    const onCommands = vi.fn(async () => undefined);
    const onError = vi.fn();
    const unsubscribe = await subscribeAgentCommandsWithFirebase(
      { deviceId: "device-1", installId: "install-1" }, onCommands, onError,
    );
    expect(getDoc).toHaveBeenCalledOnce();
    state.snapshotHandler?.({ docs: [{ id: "command-1", ref: { id: "command-1" }, data: () => ({ action: "paste", createdAt: "now", sessionId: "session-1" }) }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(onCommands).toHaveBeenCalledWith([{ id: "command-1", action: "paste", createdAt: "now", deviceId: "device-1", sessionId: "session-1" }]);
    unsubscribe();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not write or call back for an empty snapshot", async () => {
    const onCommands = vi.fn();
    const onError = vi.fn();
    await subscribeAgentCommandsWithFirebase({ deviceId: "device-1", installId: "install-1" }, onCommands, onError);
    await state.snapshotHandler?.({ docs: [] });
    expect(state.batch.commit).not.toHaveBeenCalled();
    expect(onCommands).not.toHaveBeenCalled();
  });

  it("forwards permission errors from the snapshot listener", async () => {
    const onError = vi.fn();
    await subscribeAgentCommandsWithFirebase({ deviceId: "device-1", installId: "install-1" }, vi.fn(), onError);
    const error = new Error("Missing or insufficient permissions.");
    state.errorHandler?.(error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("rejects after reporting an initial device validation error", async () => {
    vi.mocked(getDoc).mockResolvedValueOnce({ exists: () => false, data: () => undefined } as any);
    const onError = vi.fn<(error: Error) => void>();

    await expect(subscribeAgentCommandsWithFirebase(
      { deviceId: "missing-device", installId: "install-1" },
      vi.fn(),
      onError,
    )).rejects.toThrow("Firebase device not found");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("writes heartbeat once and returns the heartbeat device without reads", async () => {
    const firestoreWrite = await import("./firestoreWrite");
    vi.mocked(firestoreWrite.safeUpdateDoc).mockImplementationOnce(state.update as any);
    const result = await sendAgentHeartbeatWithFirebase({
      deviceId: "device-1",
      installId: "install-1",
      version: "0.1.44",
      activeDisplayIndex: 1,
      displays: [],
      streamDiagnostics: { desired: true, running: true } as any,
    });

    expect(getDoc).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: "devices/device-1" }),
      expect.objectContaining({
        lastSeenAtServer: "server-time",
        status: "online",
      }),
    );
    expect(result.device).toMatchObject({ id: "device-1", status: "online", version: "0.1.44", activeDisplayIndex: 1 });
  });

  it("maps Firestore not-found heartbeat updates to status 404", async () => {
    const firestoreWrite = await import("./firestoreWrite");
    vi.mocked(firestoreWrite.safeUpdateDoc).mockRejectedValueOnce({ code: "not-found" });

    await expect(sendAgentHeartbeatWithFirebase({ deviceId: "missing-device", installId: "install-1" }))
      .rejects.toMatchObject({ message: "Firebase device not found", status: 404 });
  });
});
