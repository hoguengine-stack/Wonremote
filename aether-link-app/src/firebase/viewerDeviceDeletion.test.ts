import { beforeEach, describe, expect, it, vi } from "vitest";
import { collection, doc, getDoc, getDocs, writeBatch } from "firebase/firestore";
import { deleteFirebaseDevice } from "./viewerFirebase";

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/auth")>()),
  getIdTokenResult: vi.fn(async () => ({ claims: {} })),
}));

const CENTRAL_VIEWER_UID = "Xjjdvk0Nx1eqCvND4yIOHbM53tl1";

const mockState = vi.hoisted(() => ({
  batch: {
    commit: vi.fn(async () => undefined),
    delete: vi.fn(),
    update: vi.fn(),
  },
  services: {
    auth: { currentUser: { uid: "Xjjdvk0Nx1eqCvND4yIOHbM53tl1" } },
    db: { app: "db" },
    functions: {},
  },
}));

vi.mock("./firebaseConfig", () => ({
  resolveFirebaseConfig: vi.fn(() => ({
    apiKey: "api-key",
    appId: "app-id",
    authDomain: "wonremote.test",
    projectId: "wonremote-test",
  })),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => mockState.services),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join("/") })),
  doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join("/") })),
  getDoc: vi.fn(async () => ({ exists: () => true })),
  getDocs: vi.fn(async () => ({
    docs: [
      { ref: { path: "devices/device-1/commands/command-1" } },
      { ref: { path: "devices/device-1/commands/command-2" } },
    ],
  })),
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(() => mockState.batch),
}));

describe("Viewer Firebase device deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.services.auth.currentUser = { uid: CENTRAL_VIEWER_UID };
  });

  it("clears queued commands and soft-deletes the device without losing its identity", async () => {
    await deleteFirebaseDevice("device-1");

    expect(doc).toHaveBeenCalledWith(mockState.services.db, "devices", "device-1");
    expect(collection).toHaveBeenCalledWith(
      mockState.services.db,
      "devices",
      "device-1",
      "commands",
    );
    expect(getDoc).toHaveBeenCalledWith({ path: "devices/device-1" });
    expect(getDocs).toHaveBeenCalledWith({ path: "devices/device-1/commands" });
    expect(mockState.batch.delete).toHaveBeenNthCalledWith(1, {
      path: "devices/device-1/commands/command-1",
    });
    expect(mockState.batch.delete).toHaveBeenNthCalledWith(2, {
      path: "devices/device-1/commands/command-2",
    });
    expect(mockState.batch.update).toHaveBeenCalledWith(
      { path: "devices/device-1" },
      expect.objectContaining({ deletedAt: "server-time", status: "offline", updatedAt: "server-time" }),
    );
    expect(mockState.batch.commit).toHaveBeenCalledOnce();
    expect(writeBatch).toHaveBeenCalledWith(mockState.services.db);
  });

  it("rejects deletion when the signed-in user is not the central Viewer", async () => {
    mockState.services.auth.currentUser = { uid: "not-central-viewer" };

    await expect(deleteFirebaseDevice("device-1")).rejects.toThrow(
      "Only the central Viewer can delete devices.",
    );

    expect(getDoc).not.toHaveBeenCalled();
    expect(mockState.batch.commit).not.toHaveBeenCalled();
  });
});
