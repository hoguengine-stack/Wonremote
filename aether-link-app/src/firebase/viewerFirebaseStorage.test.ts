import { describe, expect, it, vi, beforeEach } from "vitest";
import { addDoc } from "firebase/firestore";
import { deleteObject, ref, uploadBytesResumable } from "firebase/storage";
import { deleteFirebaseStorageFile, uploadFirebaseFileToStorage } from "./viewerFirebase";

const mockState = vi.hoisted(() => ({
  services: {
    auth: { currentUser: { uid: "viewer-uid" } },
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

vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(async () => ({ id: "file-doc-1" })),
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ segments })),
  serverTimestamp: vi.fn(() => "server-time"),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {},
  createUserWithEmailAndPassword: vi.fn(),
  onAuthStateChanged: vi.fn(),
  setPersistence: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("firebase/storage", () => ({
  deleteObject: vi.fn(async () => undefined),
  ref: vi.fn((_storage: unknown, path: string) => ({ fullPath: path })),
  uploadBytesResumable: vi.fn((storageRef: { fullPath: string }) => ({
    on: vi.fn((_event: string, onProgress: (snapshot: { bytesTransferred: number; totalBytes: number }) => void, _onError: (error: Error) => void, onComplete: () => void) => {
      onProgress({ bytesTransferred: 3, totalBytes: 7 });
      onComplete();
      return vi.fn();
    }),
    snapshot: { ref: storageRef },
  })),
}));

describe("Firebase Storage file upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads the file body to Storage and stores only delivery metadata in Firestore", async () => {
    const progress: Array<{ sentBytes: number; totalBytes: number }> = [];

    const result = await uploadFirebaseFileToStorage("session-device-1", {
      file: new Blob(["payload"]),
      fileSha256: "a".repeat(64),
      filename: "large report.txt",
      onProgress: (sentBytes, totalBytes) => progress.push({ sentBytes, totalBytes }),
      totalBytes: 7,
      transferId: "transfer-1",
    });

    expect(ref).toHaveBeenCalledWith(
      mockState.services.storage,
      "sessions/session-device-1/files/transfer-1/large_report.txt",
    );
    expect(uploadBytesResumable).toHaveBeenCalled();
    expect(result).toEqual({ storagePath: "sessions/session-device-1/files/transfer-1/large_report.txt" });
    expect(progress).toEqual([{ sentBytes: 3, totalBytes: 7 }]);
    expect(addDoc).toHaveBeenCalledWith(
      { segments: ["sessions", "session-device-1", "files"] },
      expect.objectContaining({
        delivery: "firebase-storage",
        fileData: "",
        fileSha256: "a".repeat(64),
        filename: "large report.txt",
        isLast: true,
        sender: "viewer",
        storagePath: "sessions/session-device-1/files/transfer-1/large_report.txt",
        target: "agent",
        totalBytes: 7,
        totalChunks: 1,
        transferId: "transfer-1",
      }),
    );
    expect(addDoc).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ downloadUrl: expect.any(String) }));
  });

  it("omits undefined optional checksum fields from Storage metadata writes", async () => {
    await uploadFirebaseFileToStorage("session-device-1", {
      file: new Blob(["payload"]),
      filename: "payload.bin",
      totalBytes: 7,
      transferId: "transfer-no-checksum",
    });

    const metadata = vi.mocked(addDoc).mock.calls[0][1] as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("fileSha256");
    expect(metadata).not.toHaveProperty("downloadUrl");
  });

  it("cancels an in-flight Storage upload and does not write file metadata", async () => {
    let reportUploadError: ((error: Error) => void) | undefined;
    const cancel = vi.fn(() => {
      reportUploadError?.(new Error("storage canceled"));
      return true;
    });
    const storageRef = { fullPath: "sessions/session-device-1/files/transfer-cancel/payload.bin" };
    vi.mocked(uploadBytesResumable).mockImplementationOnce(() => ({
      cancel,
      on: vi.fn((_event, _onProgress, onError) => {
        reportUploadError = onError;
        return vi.fn();
      }),
      snapshot: { ref: storageRef },
    }) as any);
    const controller = new AbortController();
    const uploadPromise = uploadFirebaseFileToStorage("session-device-1", {
      file: new Blob(["payload"]),
      filename: "payload.bin",
      signal: controller.signal,
      totalBytes: 7,
      transferId: "transfer-cancel",
    });

    await Promise.resolve();
    controller.abort();

    await expect(uploadPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("removes a completed Storage object when cancellation wins before metadata creation", async () => {
    const controller = new AbortController();
    const storageRef = { fullPath: "sessions/session-device-1/files/transfer-late/payload.bin" };
    vi.mocked(uploadBytesResumable).mockImplementationOnce(() => ({
      cancel: vi.fn(),
      on: vi.fn((_event, _onProgress, _onError, onComplete) => {
        controller.abort();
        onComplete();
        return vi.fn();
      }),
      snapshot: { ref: storageRef },
    }) as any);

    const uploadPromise = uploadFirebaseFileToStorage("session-device-1", {
      file: new Blob(["payload"]),
      filename: "payload.bin",
      signal: controller.signal,
      totalBytes: 7,
      transferId: "transfer-late",
    });

    await expect(uploadPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(deleteObject).toHaveBeenCalledWith(storageRef);
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("deletes the session-owned Storage object after Agent receipt", async () => {
    await deleteFirebaseStorageFile("sessions/session-device-1/files/transfer-1/large_report.txt");

    expect(deleteObject).toHaveBeenCalledWith({
      fullPath: "sessions/session-device-1/files/transfer-1/large_report.txt",
    });
  });
});
