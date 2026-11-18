import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDoc, getDocFromServer, getDocs, getDocsFromServer, onSnapshot, runTransaction } from "firebase/firestore";
import {
  fetchActiveFirebaseSessionsForAgent,
  fetchAgentZookNumberWithFirebase,
  pollAgentCommandsWithFirebase,
  queueAgentHealthChallengeWithFirebase,
  subscribeAgentCommandsWithFirebase,
} from "./agentFirebase";
import { sendAgentHeartbeatWithFirebase } from "./agentFirebase";

const state = vi.hoisted(() => ({
  services: { auth: { currentUser: { uid: "agent-uid" } }, db: {} },
  snapshotHandler: undefined as ((snapshot: any) => void) | undefined,
  errorHandler: undefined as ((error: unknown) => void) | undefined,
  unsubscribe: vi.fn(),
  batch: { commit: vi.fn(async (): Promise<void> => undefined), update: vi.fn() },
  transaction: { get: vi.fn(), update: vi.fn() },
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
  getDocFromServer: vi.fn(),
  getDocs: vi.fn(),
  getDocsFromServer: vi.fn(),
  limit: vi.fn((value: number) => ({ limit: value })),
  onSnapshot: vi.fn((_query: unknown, optionsOrNext: unknown, nextOrError: (value: any) => void, error?: (value: unknown) => void) => {
    state.snapshotHandler = typeof optionsOrNext === "function" ? optionsOrNext as (snapshot: unknown) => void : nextOrError;
    state.errorHandler = error ?? nextOrError;
    return state.unsubscribe;
  }),
  orderBy: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  runTransaction: vi.fn(async (_db:unknown, run:(tx:typeof state.transaction) => Promise<unknown>) => run(state.transaction)),
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
  metadata:{fromCache:false}, docs, docChanges: () => added.map((doc) => ({ type: "added", doc })),
});
const missingCommand = () => Object.assign(new Error("No document to update"), { code: "not-found" });
const flushCommands = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

describe("Agent Firebase command subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshotHandler = undefined;
    state.errorHandler = undefined;
    state.batch.commit.mockReset().mockResolvedValue(undefined);
    state.transaction.get.mockReset().mockResolvedValue({exists:() => true, data:() => ({state:"pending"})});
    state.update.mockReset().mockResolvedValue(undefined);
    vi.mocked(getDocsFromServer).mockReset().mockResolvedValue(snapshot([]) as any);
  });
  afterEach(() => vi.useRealTimers());
  it("reads one fresh ZOOK request document only on explicit command, with no retry", async () => {
    vi.mocked(getDocFromServer).mockResolvedValueOnce({exists:()=>true,data:()=>({zookNumber:"00123456"})} as any);
    expect(await fetchAgentZookNumberWithFirebase("device-1")).toBe("00123456");
    expect(getDocFromServer).toHaveBeenCalledOnce();
    vi.mocked(getDocFromServer).mockRejectedValueOnce(new Error("quota"));
    await expect(fetchAgentZookNumberWithFirebase("device-1")).rejects.toThrow("quota");
    expect(getDocFromServer).toHaveBeenCalledTimes(2);
    expect(state.update).not.toHaveBeenCalled();
  });

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

  it("reports command receiver readiness only after the first listener snapshot", async () => {
    const onReady = vi.fn();
    await subscribeAgentCommandsWithFirebase(
      { deviceId: "device-1", installId: "install-1", onReady },
      vi.fn(),
      vi.fn(),
    );
    expect(onReady).not.toHaveBeenCalled();
    state.snapshotHandler?.(snapshot([]));
    state.snapshotHandler?.(snapshot([]));
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("queues one health challenge through the fixed reusable command document", async () => {
    const firestoreWrite = await import("./firestoreWrite");
    await queueAgentHealthChallengeWithFirebase({
      deviceId: "device-1",
      challengeId: "00000000-0000-4000-8000-000000000001",
    });

    expect(firestoreWrite.safeSetDoc).toHaveBeenCalledWith(
      { path: "devices/device-1/commands/agent-health" },
      {
        action: "agent-health-check 00000000-0000-4000-8000-000000000001",
        createdAt: "server-time",
        state: "pending",
      },
    );
  });

  it("rejects malformed health challenge IDs before any cloud write", async () => {
    const firestoreWrite = await import("./firestoreWrite");
    await expect(queueAgentHealthChallengeWithFirebase({ deviceId: "device-1", challengeId: "bad" }))
      .rejects.toThrow("Invalid Agent health challenge");
    expect(firestoreWrite.safeSetDoc).not.toHaveBeenCalled();
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
    expect(state.transaction.get).toHaveBeenCalledTimes(code === "permission-denied" ? 1 : 0);
    expect(state.transaction.update).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });

  it("reconciles a denied batch only when an exact queued command was deleted", async () => {
    state.batch.commit.mockRejectedValueOnce(Object.assign(new Error("denied"),{code:"permission-denied"}));
    const refresh = commandDoc("refresh","refresh-status nonce");
    const replaced = commandDoc("replacement","key-up A");
    const newer = commandDoc("same-action");
    const delivered = commandDoc("delivered");
    const moved = commandDoc("moved");
    const confirmed = new Map([
      [refresh.id,{...refresh.data(),state:"pending"}],
      [replaced.id,{...replaced.data(),action:"key-up B",state:"pending"}],
      [newer.id,{...newer.data(),createdAt:"2026-09-12T00:00:01Z",state:"pending"}],
      [delivered.id,{...delivered.data(),state:"delivered"}],
      [moved.id,{...moved.data(),sessionId:"another-session",state:"pending"}],
    ]);
    state.transaction.get.mockImplementation(async (ref:{id:string}) => ({
      exists: () => confirmed.has(ref.id), data: () => confirmed.get(ref.id),
    }));
    const errors = vi.fn(), received = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},received,errors);
    state.snapshotHandler?.(snapshot([commandDoc("deleted"),refresh,replaced,newer,delivered,moved]));
    await flushCommands();
    expect(runTransaction).toHaveBeenCalledExactlyOnceWith({},expect.any(Function),{maxAttempts:1});
    expect(state.transaction.get.mock.calls.map(([ref])=>ref.id)).toEqual(["deleted","refresh","replacement","same-action","delivered","moved"]);
    expect(state.transaction.update).toHaveBeenCalledExactlyOnceWith({id:refresh.id},{state:"delivered",deliveredAt:"server-time"});
    expect(received).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({id:refresh.id,action:"refresh-status nonce"})]);
    expect(errors).not.toHaveBeenCalled();
    expect(getDocsFromServer).not.toHaveBeenCalled();
    stop();
  });

  it("does not write or execute when the server refuses the deletion proof", async () => {
    const denied = Object.assign(new Error("authorization revoked"),{code:"permission-denied"});
    state.batch.commit.mockRejectedValueOnce(denied);
    state.transaction.get.mockRejectedValue(denied);
    const errors = vi.fn(), received = vi.fn();
    await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},received,errors);
    state.snapshotHandler?.(snapshot([commandDoc("deleted"),commandDoc("refresh")]));
    await flushCommands();
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledExactlyOnceWith(denied);
    expect(state.transaction.update).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });

  it("does not acknowledge a surviving command after the subscription closes during reconciliation", async () => {
    state.batch.commit.mockRejectedValueOnce(Object.assign(new Error("denied"),{code:"permission-denied"}));
    let finish!: (snapshot:unknown) => void;
    state.transaction.get.mockResolvedValueOnce({exists:() => false, data:() => undefined});
    state.transaction.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const command = commandDoc("refresh");
    const errors = vi.fn(), received = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},received,errors);
    state.snapshotHandler?.(snapshot([commandDoc("deleted"),command]));
    await flushCommands();
    stop();
    finish({exists:() => true, data:() => ({...command.data(),state:"pending"})});
    await flushCommands();
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(state.transaction.update).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(["added", "modified"] as const)("keeps a new fixed health challenge from a %s event while the older callback is in flight", async type => {
    const first = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000001");
    const second = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000002");
    let server = first;
    state.transaction.get.mockImplementation(async () => ({data:() => ({...server.data(),state:"pending"})}));
    let finish!: () => void;
    const commands = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const errors = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},commands,errors);
    state.snapshotHandler?.(snapshot([first]));
    await flushCommands();
    expect(commands).toHaveBeenCalledOnce();
    server = second;
    state.snapshotHandler?.({...snapshot([second]),docChanges:()=>[{type,doc:second}]});
    state.snapshotHandler?.({...snapshot([second]),docChanges:()=>[{type:"modified",doc:second}]});
    await flushCommands();
    expect(commands).toHaveBeenCalledOnce();
    finish();
    await flushCommands();
    expect(commands.mock.calls.map(([entries])=>entries[0].action)).toEqual([first.data().action,second.data().action]);
    state.snapshotHandler?.(snapshot([second],[]));
    await flushCommands();
    expect(state.transaction.get).toHaveBeenCalledTimes(2);
    expect(commands).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    expect(state.batch.commit).not.toHaveBeenCalled();
    expect(state.transaction.update).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not mark a newer fixed health command delivered while handling a stale snapshot", async () => {
    const older = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000001");
    const latest = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000002");
    const other = commandDoc("input");
    state.transaction.get.mockResolvedValue({data:() => ({...latest.data(),state:"pending"})});
    const commands = vi.fn(), errors = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},commands,errors);
    state.snapshotHandler?.(snapshot([older,other]));
    await flushCommands();
    expect(state.batch.update).toHaveBeenCalledExactlyOnceWith(other.ref,{state:"delivered",deliveredAt:"server-time"});
    expect(state.transaction.update).not.toHaveBeenCalled();
    expect(commands).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({id:"input"})]);
    commands.mockClear();
    state.snapshotHandler?.({...snapshot([latest]),docChanges:()=>[{type:"modified",doc:latest}]});
    await flushCommands();
    expect(commands).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({action:latest.data().action})]);
    expect(errors).not.toHaveBeenCalled();
    stop();
  });

  it("checks a fixed health command only after its write is confirmed by the server", async () => {
    const health = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000001");
    state.transaction.get.mockResolvedValue({data:() => ({...health.data(),state:"pending"})});
    const commands = vi.fn(), errors = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},commands,errors);
    state.snapshotHandler?.({...snapshot([health]),metadata:{fromCache:true}});
    state.snapshotHandler?.(snapshot([{...health,metadata:{hasPendingWrites:true}} as typeof health]));
    await flushCommands();
    expect(state.transaction.get).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
    state.snapshotHandler?.(snapshot([health],[]));
    await flushCommands();
    expect(runTransaction).toHaveBeenCalledExactlyOnceWith({},expect.any(Function),{maxAttempts:2});
    expect(state.transaction.get).toHaveBeenCalledOnce();
    expect(commands).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({action:health.data().action})]);
    expect(errors).not.toHaveBeenCalled();
    stop();
  });

  it("keeps ordinary commands flowing while a fixed-health transaction runs out of attempts", async () => {
    const old = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000001");
    const newer = commandDoc("agent-health","agent-health-check 00000000-0000-4000-8000-000000000002");
    let rejectContention!: (error:Error) => void;
    vi.mocked(runTransaction).mockImplementationOnce(() => new Promise((_resolve,reject) => { rejectContention = reject; }));
    state.transaction.get.mockResolvedValue({data:() => ({...newer.data(),state:"pending"})});
    const commands = vi.fn(), errors = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},commands,errors);
    state.snapshotHandler?.(snapshot([old,commandDoc("first-input")]));
    await flushCommands();
    expect(commands).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({id:"first-input"})]);
    state.snapshotHandler?.(snapshot([commandDoc("next-input")]));
    await flushCommands();
    expect(commands).toHaveBeenLastCalledWith([expect.objectContaining({id:"next-input"})]);
    state.snapshotHandler?.({...snapshot([newer]),docChanges:()=>[{type:"modified",doc:newer}]});
    rejectContention(Object.assign(new Error("version conflict"),{code:"aborted"}));
    await flushCommands();
    expect(commands).toHaveBeenCalledTimes(3);
    expect(commands).toHaveBeenLastCalledWith([expect.objectContaining({action:newer.data().action})]);
    expect(state.batch.commit).toHaveBeenCalledTimes(2);
    expect(state.transaction.update).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    stop();
  });

  it("does not start deletion checks after stopping a scheduled transaction", async () => {
    state.batch.commit.mockRejectedValueOnce(Object.assign(new Error("denied"),{code:"permission-denied"}));
    let start!: () => void;
    vi.mocked(runTransaction).mockImplementationOnce((_db, run) => new Promise((resolve,reject) => {
      start = () => { void run(state.transaction as any).then(resolve,reject); };
    }));
    const commands = vi.fn(), errors = vi.fn();
    const stop = await subscribeAgentCommandsWithFirebase({deviceId:"d",installId:"install-1"},commands,errors);
    state.snapshotHandler?.(snapshot([commandDoc("deleted")]));
    await flushCommands();
    stop();
    start();
    await flushCommands();
    expect(state.transaction.get).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
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

  it("recovers only the newest recently started connected session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T03:30:00.000Z"));
    vi.mocked(getDocs).mockResolvedValueOnce({
      docs: [
        { id: "stale", data: () => ({ startedAt: "2026-09-16T05:03:13.448Z" }) },
        { id: "recent", data: () => ({ startedAt: "2026-09-17T03:29:00.000Z" }) },
      ],
    } as any);

    await expect(fetchActiveFirebaseSessionsForAgent({ deviceId: "device-1", installId: "install-1" }))
      .resolves.toEqual([{ id: "recent", deviceId: "device-1" }]);
  });

  it("does not recover when every connected session is stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T03:30:00.000Z"));
    vi.mocked(getDocs).mockResolvedValueOnce({
      docs: [{ id: "stale", data: () => ({ startedAt: "2026-07-12T18:24:03.776Z" }) }],
    } as any);

    await expect(fetchActiveFirebaseSessionsForAgent({ deviceId: "device-1", installId: "install-1" }))
      .resolves.toEqual([]);
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
      zookResult: {appliedNumber:"00123456",error:"cancel failed"},
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
        zookAppliedNumber:"00123456",
        zookError:"cancel failed",
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

  it("does not erase known diagnostics when a heartbeat has none, but may report a confirmed empty display list", async () => {
    const writes = await import("./firestoreWrite");
    const update = vi.mocked(writes.safeUpdateDoc);
    const input = {deviceId:"device-1",installId:"install-1",heartbeatRequestId:"refresh-nonce"};
    await sendAgentHeartbeatWithFirebase(input);
    const unavailable = update.mock.calls[0][1];
    expect(unavailable).toMatchObject({heartbeatRequestId:"refresh-nonce",status:"online",lastSeenAtServer:"server-time"});
    expect(unavailable).not.toHaveProperty("displays");
    expect(unavailable).not.toHaveProperty("controlDiagnostics");
    await sendAgentHeartbeatWithFirebase({...input,displays:[],controlDiagnostics:{elevated:false}});
    expect(update.mock.calls[1][1]).toMatchObject({displays:[],controlDiagnostics:{elevated:false}});
    expect(update).toHaveBeenCalledTimes(2);
    expect(getDoc).not.toHaveBeenCalled();
    expect(getDocsFromServer).not.toHaveBeenCalled();
  });

  it("maps Firestore not-found heartbeat updates to status 404", async () => {
    const firestoreWrite = await import("./firestoreWrite");
    vi.mocked(firestoreWrite.safeUpdateDoc).mockRejectedValueOnce({ code: "not-found" });

    await expect(sendAgentHeartbeatWithFirebase({ deviceId: "missing-device", installId: "install-1" }))
      .rejects.toMatchObject({ message: "Firebase device not found", status: 404 });
  });
});
