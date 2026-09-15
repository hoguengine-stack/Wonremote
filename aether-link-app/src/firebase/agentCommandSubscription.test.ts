import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDoc, getDocs, getDocsFromServer, onSnapshot } from "firebase/firestore";
import { pollAgentCommandsWithFirebase, subscribeAgentCommandsWithFirebase } from "./agentFirebase";
import { sendAgentHeartbeatWithFirebase } from "./agentFirebase";

const state = vi.hoisted(() => ({
  services: { auth: { currentUser: { uid: "agent-uid" } }, db: {} },
  snapshotHandler: undefined as ((snapshot: any) => void) | undefined,
  errorHandler: undefined as ((error: unknown) => void) | undefined,
  unsubscribe: vi.fn(),
  batch: { commit: vi.fn(async (): Promise<void> => undefined), update: vi.fn() },
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
  getDocsFromServer: vi.fn(),
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

const commandDoc = (id: string, action = "key-up A") => ({
  id, ref: { id }, data: () => ({ action, createdAt: "2026-09-12T00:00:00Z", sessionId: "session-1" }),
});
const snapshot = (docs: ReturnType<typeof commandDoc>[], added = docs) => ({
  docs, docChanges: () => added.map((doc) => ({ type: "added", doc })),
});
const missingCommand = () => Object.assign(new Error("No document to update"), { code: "not-found" });
const flushCommands = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

describe("Agent Firebase command subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshotHandler = undefined;
    state.errorHandler = undefined;
    state.batch.commit.mockReset().mockResolvedValue(undefined);
    state.update.mockReset().mockResolvedValue(undefined);
    vi.mocked(getDocsFromServer).mockReset().mockResolvedValue(snapshot([]) as any);
  });
  afterEach(() => vi.useRealTimers());

  it("validates the device once and delivers pending commands after marking them delivered", async () => {
    const onCommands = vi.fn(async () => undefined);
    const onError = vi.fn();
    const unsubscribe = await subscribeAgentCommandsWithFirebase(
      { deviceId: "device-1", installId: "install-1" }, onCommands, onError,
    );
    expect(getDoc).toHaveBeenCalledOnce();
    state.snapshotHandler?.(snapshot([{ id: "command-1", ref: { id: "command-1" }, data: () => ({ action: "paste", createdAt: "now", sessionId: "session-1" }) }]));
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
    await state.snapshotHandler?.(snapshot([]));
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

  it("keeps fresh refresh and input commands after an older acknowledgement target disappears", async () => {
    const writes = await import("./firestoreWrite");
    state.batch.commit.mockRejectedValueOnce(missingCommand());
    vi.mocked(getDocsFromServer).mockResolvedValueOnce(snapshot([
      commandDoc("fresh", "refresh-status request-1"), commandDoc("input"), commandDoc("not-in-original"),
    ]) as any);
    const received = vi.fn(); const errors = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, errors);
    state.snapshotHandler?.(snapshot([
      commandDoc("deleted"), commandDoc("fresh", "refresh-status request-1"), commandDoc("input", "key-up A"),
    ]));
    await flushCommands();
    expect(received).toHaveBeenCalledWith([
      expect.objectContaining({ id: "fresh", action: "refresh-status request-1" }),
      expect.objectContaining({ id: "input", action: "key-up A" }),
    ]);
    state.snapshotHandler?.(snapshot([commandDoc("later", "mouse-up left")]));
    await flushCommands();
    expect(received).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(getDoc).toHaveBeenCalledOnce();
    expect(getDocs).not.toHaveBeenCalled();
    expect(writes.safeUpdateDoc).not.toHaveBeenCalled();
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(state.batch.commit).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not re-acknowledge unchanged commands in overlapping slow snapshots", async () => {
    let finish!: () => void;
    state.batch.commit.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const received = vi.fn(); const first = commandDoc("first"); const next = commandDoc("next");
    const stop = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, vi.fn());
    state.snapshotHandler?.(snapshot([first]));
    await flushCommands();
    state.snapshotHandler?.(snapshot([first, next], [next]));
    finish();
    await flushCommands();
    expect(state.batch.update.mock.calls.map((call) => (call[0] as any).id)).toEqual(["first", "next"]);
    expect(received.mock.calls.flatMap(([commands]) => commands.map((c: any) => c.id))).toEqual(["first", "next"]);
    stop();
  });

  it("does no idle polling or duplicate subscription over 24h and stops queued work on cleanup", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const received = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, vi.fn());
    for (let i = 0; i < 24; i++) {
      state.snapshotHandler?.(snapshot([]));
      await vi.advanceTimersByTimeAsync(3_600_000);
    }
    expect(getDoc).toHaveBeenCalledOnce();
    expect(getDocs).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(state.batch.commit).not.toHaveBeenCalled();
    state.batch.commit.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    state.snapshotHandler?.(snapshot([commandDoc("slow")]));
    await flushCommands();
    state.snapshotHandler?.(snapshot([commandDoc("queued")]));
    stop(); finish();
    await flushCommands();
    state.snapshotHandler?.(snapshot([commandDoc("late")]));
    await flushCommands();
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it.each(["permission-denied", "resource-exhausted", "unavailable"])("does not bypass %s or continue queued work after failure", async (code) => {
    const writes = await import("./firestoreWrite");
    const error = Object.assign(new Error(code), { code });
    state.batch.commit.mockRejectedValueOnce(error);
    const errors = vi.fn(); const received = vi.fn();
    await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, errors);
    state.snapshotHandler?.(snapshot([commandDoc("first")]));
    state.snapshotHandler?.(snapshot([commandDoc("queued")]));
    await flushCommands();
    expect(errors).toHaveBeenCalledExactlyOnceWith(error);
    expect(writes.safeUpdateDoc).not.toHaveBeenCalled();
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it("bounds a full deleted batch to one failed batch and one fresh query, without reconnects", async () => {
    const writes = await import("./firestoreWrite");
    state.batch.commit.mockRejectedValueOnce(missingCommand());
    const errors = vi.fn(); const received = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, errors);
    state.snapshotHandler?.(snapshot(Array.from({ length: 50 }, (_, i) => commandDoc(`gone-${i}`))));
    await flushCommands();
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(state.batch.update).toHaveBeenCalledTimes(50);
    expect(writes.safeUpdateDoc).not.toHaveBeenCalled();
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(getDoc).toHaveBeenCalledOnce();
    expect(getDocs).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    stop();
  });

  it("stops after one fresh retry if commands are deleted again", async () => {
    state.batch.commit.mockRejectedValue(missingCommand());
    vi.mocked(getDocsFromServer).mockResolvedValueOnce(snapshot([commandDoc("gone-again")]) as any);
    const errors = vi.fn(); const received = vi.fn();
    await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, errors);
    state.snapshotHandler?.(snapshot([commandDoc("gone-again")]));
    await flushCommands();
    expect(state.batch.commit).toHaveBeenCalledTimes(2);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it("counts a 50-command deletion race and a clean listener remount without duplicate writes", async () => {
    const documents = Array.from({ length: 50 }, (_, i) => commandDoc(`command-${i}`));
    state.batch.commit.mockRejectedValueOnce(missingCommand());
    vi.mocked(getDocsFromServer).mockResolvedValueOnce(snapshot(documents.slice(1)) as any);
    const received = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, vi.fn());
    const oldCallback = state.snapshotHandler;
    oldCallback?.(snapshot(documents));
    await flushCommands();
    expect(state.batch.commit).toHaveBeenCalledTimes(2);
    expect(state.batch.update).toHaveBeenCalledTimes(99);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(received.mock.calls[0][0]).toHaveLength(49);
    stop();
    const stopAgain = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, vi.fn());
    oldCallback?.(snapshot(documents));
    state.snapshotHandler?.(snapshot([]));
    await flushCommands();
    expect(getDoc).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(state.batch.update).toHaveBeenCalledTimes(99);
    expect(received).toHaveBeenCalledOnce();
    stopAgain();
  });

  it("keeps retry acknowledgement atomic and stops if recovery loses permission", async () => {
    const writes = await import("./firestoreWrite");
    state.batch.commit.mockRejectedValueOnce(missingCommand()).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "permission-denied" }));
    vi.mocked(getDocsFromServer).mockResolvedValueOnce(snapshot([commandDoc("key-down"), commandDoc("key-up")]) as any);
    const errors = vi.fn(); const received = vi.fn();
    await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, errors);
    state.snapshotHandler?.(snapshot([commandDoc("deleted"), commandDoc("key-down"), commandDoc("key-up")]));
    await flushCommands();
    expect(writes.safeUpdateDoc).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it("does not retry or execute when unsubscribed during the fresh server query", async () => {
    state.batch.commit.mockRejectedValueOnce(missingCommand());
    let resolveQuery!: (value: any) => void;
    vi.mocked(getDocsFromServer).mockImplementationOnce(() => new Promise((resolve) => { resolveQuery = resolve; }));
    const received = vi.fn(); const stop = await subscribeAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" }, received, vi.fn());
    state.snapshotHandler?.(snapshot([commandDoc("fresh")]));
    await flushCommands();
    stop(); resolveQuery(snapshot([commandDoc("fresh")]));
    await flushCommands();
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it("applies the same missing-document recovery to the explicit Firebase poll path", async () => {
    const writes = await import("./firestoreWrite");
    vi.mocked(getDocs).mockResolvedValueOnce(snapshot([commandDoc("deleted"), commandDoc("fresh")]) as any);
    state.batch.commit.mockRejectedValueOnce(missingCommand());
    vi.mocked(getDocsFromServer).mockResolvedValueOnce(snapshot([commandDoc("fresh")]) as any);
    const result = await pollAgentCommandsWithFirebase({ deviceId: "d", installId: "install-1" });
    expect(result.commands.map((c) => c.id)).toEqual(["fresh"]);
    expect(getDocs).toHaveBeenCalledOnce();
    expect(writes.safeUpdateDoc).not.toHaveBeenCalled();
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
      desktopName: "DESKTOP-CADI3TD",
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
        selectedRolloutVersion: "0.1.44",
        rollbackSupportVersion: "0.1.44",
        desktopName: "DESKTOP-CADI3TD",
        status: "online",
      }),
    );
    expect(result.device).toMatchObject({
      id: "device-1",
      status: "online",
      desktopName: "DESKTOP-CADI3TD",
      version: "0.1.44",
      activeDisplayIndex: 1,
    });
  });

  it("maps Firestore not-found heartbeat updates to status 404", async () => {
    const firestoreWrite = await import("./firestoreWrite");
    vi.mocked(firestoreWrite.safeUpdateDoc).mockRejectedValueOnce({ code: "not-found" });

    await expect(sendAgentHeartbeatWithFirebase({ deviceId: "missing-device", installId: "install-1" }))
      .rejects.toMatchObject({ message: "Firebase device not found", status: 404 });
  });
});
