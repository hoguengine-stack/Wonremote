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
  transaction: {
    get: vi.fn<(reference: { segments: string[] }) => Promise<{ data: () => unknown; exists: () => boolean }>>(async (_reference) => ({
      data: () => undefined,
      exists: () => false,
    })),
    set: vi.fn(),
    update: vi.fn(),
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
  runTransaction: vi.fn(async (_db: unknown, update: (transaction: typeof mockState.transaction) => unknown) =>
    update(mockState.transaction)),
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
    const payload = vi.mocked(mockState.transaction.set).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("version");
  });

  it("moves a user store name and retires only the previous Agent document during reconciliation", async () => {
    mockState.transaction.get.mockImplementation(async (reference: { segments: string[] }) => {
      if (reference.segments[1] === "123-45-67890:AGENT-CBFFB65C") {
        return {
          data: () => ({
            businessNumber: "123-45-67890",
            installId: "CBFFB65C",
            ownerUid: "uid-1",
            storeName: "Gangnam Store",
            storeNameSource: "user",
          }),
          exists: () => true,
        };
      }
      return {
        data: () => undefined,
        exists: () => false,
      };
    });

    await registerAgentFirstRunWithFirebase({
      businessNumber: "123-45-67890",
      installId: "82220F6D",
      password: "1234",
      previousDeviceId: "123-45-67890:AGENT-CBFFB65C",
    });

    const targetPayload = vi.mocked(mockState.transaction.set).mock.calls[0][1] as Record<string, unknown>;
    expect(targetPayload).toMatchObject({
      storeName: "Gangnam Store",
      storeNameSource: "user",
    });
    expect(mockState.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ segments: ["devices", "123-45-67890:AGENT-CBFFB65C"] }),
      expect.objectContaining({ status: "offline" }),
    );
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
