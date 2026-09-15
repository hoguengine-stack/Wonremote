import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectFirestoreEmulator, deleteDoc, doc, getDocFromServer, getFirestore, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAgentHeartbeatWithFirebase, subscribeAgentCommandsWithFirebase } from "./agentFirebase";

const state = vi.hoisted(() => ({
  services: null as any,
  beforeCommit: null as null | (() => Promise<void>),
  failures: [] as string[],
}));
vi.mock("./firebaseConfig", () => ({ resolveFirebaseConfig: () => ({ projectId: "demo-wonremote-commands" }) }));
vi.mock("./firebaseServices", () => ({ getWonRemoteFirebaseServices: () => state.services }));
vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    writeBatch: (db: Parameters<typeof actual.writeBatch>[0]) => {
      const batch = actual.writeBatch(db);
      const commit = batch.commit.bind(batch);
      batch.commit = async () => {
        const beforeCommit = state.beforeCommit;
        state.beforeCommit = null;
        await beforeCommit?.();
        try { await commit(); }
        catch (error: any) { state.failures.push(error.code); throw error; }
      };
      return batch;
    },
  };
});

// Start the loopback emulator with repository rules, Java 21+ and
// -Duser.language=en -Duser.country=US (the emulator lacks ko_KR rule messages).
const address = process.env.FIRESTORE_EMULATOR_HOST;
if (address && !/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("This test requires a loopback Firestore emulator.");
const apps: FirebaseApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => deleteApp(app))); });

describe.skipIf(!address)("Firestore command deletion recovery with real SDK and repository rules", () => {
  it("responds to refresh and continues input after a real NOT_FOUND without recreating the deleted command", async () => {
    const makeClient = (uid: string) => {
      const app = initializeApp({ projectId: "demo-wonremote-commands", apiKey: "emulator-only", appId: uid }, uid);
      apps.push(app);
      const db = getFirestore(app);
      connectFirestoreEmulator(db, "127.0.0.1", Number(address!.split(":")[1]), { mockUserToken: { sub: uid } });
      return db;
    };
    const owner = "command-recovery-agent";
    const agent = makeClient(owner);
    const viewer = makeClient("Xjjdvk0Nx1eqCvND4yIOHbM53tl1");
    const unauthorized = makeClient("other-agent");
    state.services = { db: agent, auth: { currentUser: { uid: owner } } };
    const deviceId = `recovery-${Date.now()}`;
    const command = (db: typeof agent, id: string) => doc(db, "devices", deviceId, "commands", id);
    await setDoc(doc(agent, "devices", deviceId), {
      ownerUid: owner, businessNumber: "123-45-67890", deviceNumber: "TEST", installId: "test-install",
      status: "online", presenceMode: "manual", lastSeenAtServer: serverTimestamp(),
    });
    const requestId = "00000000-0000-0000-0000-000000000001";
    const seed = writeBatch(viewer);
    for (const [id, action] of [["old", "key-up X"], ["refresh", `refresh-status ${requestId}`]]) {
      seed.set(command(viewer, id), { action, state: "pending", createdAt: new Date().toISOString() });
    }
    await seed.commit();
    state.beforeCommit = () => deleteDoc(command(viewer, "old"));
    const received: string[] = []; const errors: Error[] = [];
    const stop = await subscribeAgentCommandsWithFirebase({ deviceId, installId: "test-install" }, async (commands) => {
      for (const next of commands) {
        received.push(next.id);
        if (next.id === "refresh") await sendAgentHeartbeatWithFirebase({ deviceId, installId: "test-install", heartbeatRequestId: requestId });
      }
    }, (error) => errors.push(error));
    try {
      await vi.waitFor(async () => {
        expect((await getDocFromServer(doc(viewer, "devices", deviceId))).data()?.heartbeatRequestId).toBe(requestId);
      }, { timeout: 10_000, interval: 100 });
      expect(state.failures).toEqual(["not-found"]);
      expect(received).toEqual(["refresh"]);
      expect((await getDocFromServer(command(viewer, "old"))).exists()).toBe(false);
      expect((await getDocFromServer(command(viewer, "refresh"))).data()?.state).toBe("delivered");
      await setDoc(command(viewer, "input"), { action: "mouse-up left", state: "pending", createdAt: new Date().toISOString() });
      await vi.waitFor(() => expect(received).toEqual(["refresh", "input"]), { timeout: 5_000 });
      expect(errors).toEqual([]);
      await expect(getDocFromServer(command(unauthorized, "input"))).rejects.toMatchObject({ code: "permission-denied" });
      stop();
      await setDoc(command(viewer, "after-stop"), { action: "key-up B", state: "pending", createdAt: new Date().toISOString() });
      expect((await getDocFromServer(command(viewer, "after-stop"))).data()?.state).toBe("pending");
      expect(received).toEqual(["refresh", "input"]);
    } finally { stop(); }
  }, 30_000);
});
