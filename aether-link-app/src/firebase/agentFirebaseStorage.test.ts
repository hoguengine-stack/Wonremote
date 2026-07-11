import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSessionDataWithFirebase, postFileTransferReceiptWithFirebase, resolveFirebaseStorageDownloadUrl } from "./agentFirebase";
import { getDownloadURL, ref } from "firebase/storage";
import { setDoc } from "firebase/firestore";

const mockState = vi.hoisted(() => ({
  docs: [] as Array<{ id: string; data: () => Record<string, unknown>; ref: unknown }>,
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
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(),
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ segments })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ segments })),
  getDoc: vi.fn(),
  getDocs: vi.fn(async (queryValue: { queueName?: string }) => ({
    docs: queryValue.queueName === "files" ? mockState.docs : [],
    empty: queryValue.queueName !== "files" || mockState.docs.length === 0,
  })),
  limit: vi.fn((value: number) => ({ limit: value })),
  orderBy: vi.fn(),
  query: vi.fn((collectionValue: { segments?: string[] }, ..._constraints: unknown[]) => ({
    queueName: collectionValue.segments?.[collectionValue.segments.length - 1],
  })),
  serverTimestamp: vi.fn(() => "server-time"),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(() => ({
    commit: vi.fn(async () => undefined),
    delete: vi.fn(),
    update: vi.fn(),
  })),
}));

vi.mock("firebase/storage", () => ({
  getDownloadURL: vi.fn(async () => "https://storage.example/download"),
  ref: vi.fn((_storage: unknown, path: string) => ({ fullPath: path })),
}));

describe("Firebase Storage files for Agent", () => {
  beforeEach(() => {
    mockState.docs = [];
    vi.clearAllMocks();
  });

  it("maps Storage file metadata from the Firebase session queue", async () => {
    mockState.docs = [
      {
        id: "file-doc-1",
        ref: { id: "file-doc-1" },
        data: () => ({
          delivery: "firebase-storage",
          filename: "large.bin",
          fileData: "",
          storagePath: "sessions/session-1/files/transfer-1/large.bin",
          target: "agent",
          totalBytes: 500 * 1024 * 1024,
          totalChunks: 1,
          transferId: "transfer-1",
          webkitRelativePath: "Store/backups/large.bin",
        }),
      },
    ];

    await expect(fetchSessionDataWithFirebase("session-1")).resolves.toMatchObject({
      files: [
        {
          delivery: "firebase-storage",
          filename: "large.bin",
          storagePath: "sessions/session-1/files/transfer-1/large.bin",
          totalBytes: 500 * 1024 * 1024,
          transferId: "transfer-1",
          webkitRelativePath: "Store/backups/large.bin",
        },
      ],
    });
  });

  it("resolves authenticated Firebase Storage download URLs from storagePath", async () => {
    await expect(resolveFirebaseStorageDownloadUrl("sessions/session-1/files/transfer-1/large.bin")).resolves.toBe(
      "https://storage.example/download",
    );

    expect(ref).toHaveBeenCalledWith(mockState.services.storage, "sessions/session-1/files/transfer-1/large.bin");
    expect(getDownloadURL).toHaveBeenCalledWith({
      fullPath: "sessions/session-1/files/transfer-1/large.bin",
    });
  });

  it("omits undefined optional fields from Firebase file receipts", async () => {
    await postFileTransferReceiptWithFirebase("session-1", {
      error: undefined,
      filename: "large.bin",
      receivedBytes: 1024,
      receivedChunks: 1,
      savedPath: undefined,
      status: "partial",
      totalChunks: 1,
      transferId: "transfer-1",
    } as any);

    const receipt = vi.mocked(setDoc).mock.calls[0][1] as Record<string, unknown>;
    expect(receipt).not.toHaveProperty("savedPath");
    expect(receipt).not.toHaveProperty("error");
  });
});
