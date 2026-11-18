import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDocFromServer, getDocsFromServer, getFirestore, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  queueAgentHealthChallengeWithFirebase,
  sendAgentHeartbeatWithFirebase,
  subscribeAgentCommandsWithFirebase,
} from "./agentFirebase";

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
afterEach(async () => {
  state.beforeCommit = null;
  state.failures.length = 0;
  state.services = null;
  await Promise.all(apps.splice(0).map((app) => deleteApp(app)));
});

describe.skipIf(!address)("Firestore command deletion recovery with real SDK and repository rules", () => {
  it.each(["inventory","selection"] as const)("refreshes the %s and confirms only current server-backed Agent replies", async scope => {
    const {fetchFirebaseDevices} = await import("./viewerFirebase");
    const makeClient = (uid: string, wonremoteViewer = false) => {
      const app = initializeApp({projectId:"demo-wonremote-commands",apiKey:"emulator-only",appId:uid}, uid);
      apps.push(app);
      const db = getFirestore(app);
      connectFirestoreEmulator(db, "127.0.0.1", Number(address!.split(":")[1]), {mockUserToken:{sub:uid,wonremoteViewer}});
      return db;
    };
    const owner = "fleet-test-agent", actor = "fleet-test-viewer";
    const agent = makeClient(owner), viewer = makeClient(actor,true);
    const suffix = Date.now();
    const active = `fleet-active-${suffix}`, silent = `fleet-silent-${suffix}`, unrelated = `fleet-unrelated-${suffix}`;
    const outside = `fleet-outside-${suffix}`;
    const device = (id:string) => doc(agent,"devices",id);
    const controller = new AbortController();
    const fixtures = [[active,"manual"],[silent,"manual"],[unrelated,"periodic"]];
    if (scope === "selection") fixtures.push([outside,"manual"]);
    try {
      for (const [id, mode] of fixtures) {
        await setDoc(device(id), {ownerUid:owner,businessNumber:"123-45-67890",deviceNumber:id,installId:id,
          status:"online",presenceMode:mode,lastSeenAtServer:serverTimestamp(),heartbeatRequestId:"previous-request"});
      }
      state.services = {db:viewer,auth:{currentUser:{uid:actor}}};
      const options = import.meta.env;
      const inventory = await fetchFirebaseDevices(options);
      const readCommands = async (id: string) => (await getDocsFromServer(collection(agent,"devices",id,"commands"))).docs;
      const progress = vi.fn();
      const refresh = fetchFirebaseDevices(options, true, controller.signal, progress, inventory,
        scope === "selection" ? [active, silent, unrelated] : undefined);
      void refresh.catch(() => undefined);
      await vi.waitFor(async () => expect(await readCommands(active)).toHaveLength(1), {timeout:3_000,interval:50});
      const [request] = await readCommands(active);
      const nonce = String(request.data().action).split(" ")[1];
      expect(nonce).toMatch(/^[a-f0-9-]{36}$/);
      await updateDoc(device(active),{heartbeatRequestId:"another-viewer",lastSeenAtServer:serverTimestamp()});
      // Another target in the same query does not confirm either pending manual device.
      await updateDoc(device(unrelated),{heartbeatRequestId:nonce,lastSeenAtServer:serverTimestamp()});
      if (scope === "selection") await updateDoc(device(outside),{heartbeatRequestId:nonce,lastSeenAtServer:serverTimestamp()});
      await updateDoc(device(silent),{heartbeatRequestId:nonce,lastSeenAtServer:serverTimestamp()});
      await vi.waitFor(() => {
        expect(progress.mock.lastCall?.[1]).toContain(active);
        expect(progress.mock.lastCall?.[1]).not.toContain(silent);
      }, {timeout:3_000,interval:50});
      await updateDoc(device(active),{heartbeatRequestId:nonce,lastSeenAtServer:serverTimestamp()});
      const result = await refresh;
      if (scope === "selection") expect(result.map(row=>row.id).sort()).toEqual([active,silent,unrelated].sort());
      for (const id of [active,silent]) expect(result.find(row=>row.id===id)?.status).toBe("online");
      expect(await readCommands(active)).toHaveLength(1);
      expect(await readCommands(silent)).toHaveLength(1);
      expect(await readCommands(unrelated)).toHaveLength(0);
      if (scope === "selection") expect(await readCommands(outside)).toHaveLength(0);
    } finally {
      controller.abort();
      await Promise.all(fixtures.map(async ([id]) => {
        const commands = await getDocsFromServer(collection(viewer,"devices",id,"commands"));
        await Promise.all(commands.docs.map(command => deleteDoc(command.ref)));
        await deleteDoc(doc(viewer,"devices",id));
      }));
    }
  }, 15_000);

  it("responds to refresh and continues input after a real command deletion without recreating it", async () => {
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
    const diagnostics = {displays:[{index:0,width:1024,height:768}],controlDiagnostics:{elevated:true}};
    await setDoc(doc(agent, "devices", deviceId), {
      ownerUid: owner, businessNumber: "123-45-67890", deviceNumber: "TEST", installId: "test-install",
      status: "online", presenceMode: "manual", lastSeenAtServer: serverTimestamp(), ...diagnostics,
    });
    const requestId = "00000000-0000-0000-0000-000000000001";
    const seed = writeBatch(viewer);
    for (const [id, action] of [["old", "key-up X"], ["refresh", `refresh-status ${requestId}`]]) {
      seed.set(command(viewer, id), { action, state: "pending", createdAt: serverTimestamp() });
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
        expect((await getDocFromServer(doc(viewer, "devices", deviceId))).data()).toMatchObject({heartbeatRequestId:requestId,...diagnostics});
      }, { timeout: 10_000, interval: 100 });
      // Pinned emulator 1.22.0 classifies this deletion as a rule-time denial.
      expect(state.failures).toEqual(["permission-denied"]);
      expect(received).toEqual(["refresh"]);
      expect((await getDocFromServer(command(viewer, "old"))).exists()).toBe(false);
      expect((await getDocFromServer(command(viewer, "refresh"))).data()?.state).toBe("delivered");
      await setDoc(command(viewer, "input"), { action: "mouse-up left", state: "pending", createdAt: new Date().toISOString() });
      await vi.waitFor(() => expect(received).toEqual(["refresh", "input"]), { timeout: 5_000 });
      expect(errors).toEqual([]);
      await expect(getDocFromServer(command(unauthorized, "input"))).rejects.toMatchObject({ code: "permission-denied" });

      // If the disputed document still exists, the denial is not a deletion.
      state.beforeCommit = () => updateDoc(command(agent, "already-delivered"), {
        state:"delivered",deliveredAt:serverTimestamp(),
      });
      await setDoc(command(viewer, "already-delivered"), {action:"key-up A",state:"pending",createdAt:serverTimestamp()});
      await vi.waitFor(() => expect(errors).toEqual([expect.objectContaining({code:"permission-denied"})]), {timeout:5_000,interval:50});
      expect(received).toEqual(["refresh","input"]);
      stop();
      await setDoc(command(viewer, "after-stop"), { action: "key-up B", state: "pending", createdAt: new Date().toISOString() });
      expect((await getDocFromServer(command(viewer, "after-stop"))).data()?.state).toBe("pending");
      expect(received).toEqual(["refresh", "input"]);
    } finally { stop(); }
  }, 30_000);

  it("reuses one fixed health document and receives each exact challenge through the real listener", async () => {
    const makeClient = (uid: string) => {
      const app = initializeApp({ projectId: "demo-wonremote-commands", apiKey: "emulator-only", appId: uid }, uid);
      apps.push(app);
      const db = getFirestore(app);
      connectFirestoreEmulator(db, "127.0.0.1", Number(address!.split(":")[1]), { mockUserToken: { sub: uid } });
      return db;
    };
    const owner = "health-roundtrip-agent";
    const agent = makeClient(owner);
    state.services = { db: agent, auth: { currentUser: { uid: owner } } };
    const deviceId = `health-${Date.now()}`;
    const healthRef = doc(agent, "devices", deviceId, "commands", "agent-health");
    await setDoc(doc(agent, "devices", deviceId), {
      ownerUid: owner, businessNumber: "123-45-67890", deviceNumber: "HEALTH", installId: "health-install",
      status: "online", presenceMode: "manual", lastSeenAtServer: serverTimestamp(),
    });
    const received: string[] = [];
    const errors: Error[] = [];
    const first = "00000000-0000-4000-8000-000000000001";
    let finishFirst!: () => void;
    const firstHandling = new Promise<void>(resolve => { finishFirst = resolve; });
    await queueAgentHealthChallengeWithFirebase({ deviceId, challengeId: first });
    const stop = await subscribeAgentCommandsWithFirebase(
      { deviceId, installId: "health-install" },
      async commands => {
        received.push(...commands.map(command => command.action));
        if (received.length === 1) await firstHandling;
      },
      (error) => errors.push(error),
    );
    try {
      await vi.waitFor(async () => {
        expect((await getDocFromServer(healthRef)).data()).toMatchObject({
          action: `agent-health-check ${first}`,
          state: "delivered",
        });
      }, { timeout: 10_000, interval: 100 });
      const second = "00000000-0000-4000-8000-000000000002";
      await queueAgentHealthChallengeWithFirebase({ deviceId, challengeId: second });
      await vi.waitFor(async () => expect((await getDocFromServer(healthRef)).data()).toMatchObject({
        action:`agent-health-check ${second}`,state:"pending",
      }), {timeout:5_000,interval:50});
      expect(received).toEqual([`agent-health-check ${first}`]);
      finishFirst();
      await vi.waitFor(() => expect(received).toEqual([
        `agent-health-check ${first}`,
        `agent-health-check ${second}`,
      ]), { timeout: 10_000, interval: 100 });
      expect((await getDocFromServer(healthRef)).data()).toMatchObject({
        action: `agent-health-check ${second}`,
        state: "delivered",
      });
      expect(errors).toEqual([]);
    } finally { finishFirst(); stop(); }
  }, 30_000);
});
