import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithEmailAndPassword } from "firebase/auth";
import { setDoc } from "firebase/firestore";
import { registerAgentFirstRunWithFirebase } from "./agentFirebase";
import { registerFirstRunAgentWithFirebase } from "./viewerFirebase";

const mockState = vi.hoisted(() => ({
  services: {
    auth: { currentUser: { uid: "agent-uid" } },
    db: {},
    functions: {},
    storage: {},
  },
}));

vi.mock("./firebaseConfig", () => ({
  resolveFirebaseConfig: vi.fn(() => ({
    apiKey: "api-key",
    appId: "app-id",
    authDomain: "wonremote.test",
    projectId: "wonremote-test",
    storageBucket: "wonremote-test.appspot.com",
  })),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => mockState.services),
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: "local",
  createUserWithEmailAndPassword: vi.fn(async () => ({ user: { uid: "uid-1" } })),
  onAuthStateChanged: vi.fn(),
  setPersistence: vi.fn(async () => undefined),
  signInWithEmailAndPassword: vi.fn(async () => ({ user: { uid: "uid-1" } })),
  signOut: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(),
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ segments })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ segments })),
  getDoc: vi.fn(async () => ({
    data: () => undefined,
    exists: () => false,
  })),
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  setDoc: vi.fn(async () => undefined),
  updateDoc: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: vi.fn(),
}));

vi.mock("firebase/storage", () => ({
  getDownloadURL: vi.fn(),
  ref: vi.fn(),
  uploadBytesResumable: vi.fn(),
}));

describe("Firebase first-run registration payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits undefined version when the Agent registers for the first time", async () => {
    await registerAgentFirstRunWithFirebase({
      businessNumber: "3600602052",
      installId: "agent-3d00c5bf",
      password: "1234",
    });

    expect(signInWithEmailAndPassword).toHaveBeenCalled();
    const payload = vi.mocked(setDoc).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("version");
  });

  it("omits undefined version when the Viewer first-run registration path is used", async () => {
    await registerFirstRunAgentWithFirebase({
      businessNumber: "3600602052",
      installId: "agent-3d00c5bf",
      password: "1234",
    } as any);

    const payload = vi.mocked(setDoc).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("version");
  });
});
