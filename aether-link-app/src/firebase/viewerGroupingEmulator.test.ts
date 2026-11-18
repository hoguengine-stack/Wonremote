import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { randomUUID } from "node:crypto";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { expect, it, vi } from "vitest";
import { applyViewerGroupEdit, type ViewerGrouping } from "../domain/viewerGroups";
import { saveViewerGrouping, subscribeViewerGrouping } from "./viewerFirebase";

const fixture = vi.hoisted(() => ({
  clients: new Map<string, { db: Firestore; auth: { currentUser: { uid: string } } }>(),
  beforeCommit: new Map<Firestore, () => Promise<void>>(),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: (config: FirebaseOptions) => {
    const client = fixture.clients.get(config.appId ?? "");
    if (!client) throw new Error("No localhost Firestore client for this fixture.");
    return client;
  },
}));

vi.mock("firebase/firestore", async importOriginal => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    runTransaction: ((db, update, options) => {
      const beforeCommit = fixture.beforeCommit.get(db);
      return actual.runTransaction(db, async transaction => {
        const result = await update(transaction);
        await beforeCommit?.();
        return result;
      }, options);
    }) as typeof actual.runTransaction,
  };
});

const port = process.env.WONREMOTE_GROUPING_EMULATOR_PORT;

it.skipIf(!port)("keeps both Viewer edits after a forced Firestore transaction retry", async () => {
  const emulatorPort = Number(port);
  expect(Number.isInteger(emulatorPort) && emulatorPort > 0 && emulatorPort <= 65_535).toBe(true);
  const testId = randomUUID();
  const uid = `viewer-${testId}`;
  const apps: FirebaseApp[] = [];
  const openClient = (name: string) => {
    const app = initializeApp({ projectId: "demo-wonremote-grouping", apiKey: "fixture-only" }, `${name}-${testId}`);
    apps.push(app);
    const db = getFirestore(app);
    connectFirestoreEmulator(db, "127.0.0.1", emulatorPort, { mockUserToken: { sub: uid, wonremoteViewer: true } });
    fixture.clients.set(name, { db, auth: { currentUser: { uid } } });
    const env: ImportMetaEnv = {
      MODE: name, BASE_URL: "/", DEV: false, PROD: false, SSR: true, VITE_WONREMOTE_APP_VERSION: "0.0.0-test",
      VITE_WONREMOTE_FIREBASE_APP_ID: name, VITE_WONREMOTE_FIREBASE_API_KEY: "fixture-only",
      VITE_WONREMOTE_FIREBASE_PROJECT_ID: "demo-wonremote-grouping", VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN: "localhost",
    };
    return { db, env };
  };
  const group = { id: "group-1", name: "Store Group", parentId: null, deviceIds: ["pos-1"] };
  const initial: ViewerGrouping = { customGroups: [group], groupOrder: ["Store A", "Store B"] };
  const draft = { ...group, deviceIds: ["pos-1", "pos-2"] };
  const expected: ViewerGrouping = { customGroups: [draft], groupOrder: ["Store B", "Store A"] };
  const accepted: ViewerGrouping[] = [];
  const errors: Error[] = [];
  const cancellation = new AbortController();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  let stop: (() => void) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error("Grouping emulator did not finish in 12 seconds.")), 12_000);
  });
  const beforeDeadline = <T,>(operation: Promise<T>) => Promise.race([operation, deadline]);

  try {
    const a = openClient("viewer-a");
    const b = openClient("viewer-b");
    await beforeDeadline(saveViewerGrouping(uid, () => initial, a.env));
    stop = subscribeViewerGrouping(uid, value => accepted.push(value), error => errors.push(error), b.env);
    await beforeDeadline(vi.waitFor(() => expect(accepted).toContainEqual(initial), { timeout: 5_000 }));
    fixture.beforeCommit.set(b.db, async () => {
      if (++attempts === 1) await paused;
      cancellation.signal.throwIfAborted();
    });

    const pending = saveViewerGrouping(uid, current => ({ ...current, groupOrder: expected.groupOrder }), b.env);
    void pending.catch(() => undefined);
    await beforeDeadline(vi.waitFor(() => expect(attempts).toBe(1), { timeout: 5_000 }));
    await beforeDeadline(saveViewerGrouping(uid, current => ({
      ...current, customGroups: applyViewerGroupEdit(current.customGroups, group, draft),
    }), a.env));
    release();
    await beforeDeadline(pending);

    expect(attempts).toBeGreaterThanOrEqual(2);
    await beforeDeadline(vi.waitFor(() => expect(accepted[accepted.length - 1]).toEqual(expected), { timeout: 5_000 }));
    expect(errors).toEqual([]);
  } finally {
    clearTimeout(deadlineTimer);
    cancellation.abort();
    release();
    stop?.();
    fixture.clients.clear();
    fixture.beforeCommit.clear();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupDeadline = new Promise<never>((_, reject) => {
      cleanupTimer = setTimeout(() => reject(new Error("Grouping emulator clients did not close.")), 2_000);
    });
    try {
      await Promise.race([Promise.allSettled(apps.map(app => deleteApp(app))), cleanupDeadline]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
}, 20_000);
