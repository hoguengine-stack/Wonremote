import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevice } from "../domain/types";
import {
  fetchFirebaseDevices,
  fetchFirebaseFileTransferReceipts,
  fetchFirebaseTiles,
  isViewerFirebaseEnabled,
  logoutViewerWithFirebase,
  uploadFirebaseFileToStorage,
  uploadFirebaseFileChunk,
} from "../firebase/viewerFirebase";
import { fetchDevices, fetchFileTransferReceipts, fetchTiles, logoutAdmin, uploadFileChunk, uploadFileToStorage } from "./viewerApi";

const mockState = vi.hoisted(() => ({
  firebaseEnabled: true,
  firebaseDevices: [
    {
      businessNumber: "123-45-67890",
      desktopName: "DESKTOP-TEST",
      deviceName: "Counter POS",
      deviceNumber: "POS-01",
      id: "device-1",
      lastSeenAt: "2026-06-15T00:00:00.000Z",
      status: "online",
      storeName: "Test Store",
    },
  ] as ManagedDevice[],
}));

vi.mock("../firebase/viewerFirebase", () => ({
  closeFirebaseSession: vi.fn(),
  fetchFirebaseChatMessages: vi.fn(async () => []),
  fetchFirebaseDevices: vi.fn(async () => mockState.firebaseDevices),
  fetchFirebaseClipboardText: vi.fn(async () => []),
  fetchFirebaseFileTransferReceipts: vi.fn(async () => []),
  fetchFirebaseFiles: vi.fn(async () => []),
  fetchFirebaseSessionStatus: vi.fn(),
  fetchFirebaseTiles: vi.fn(async () => ({ tiles: [{ x: 0, y: 0, w: 32, h: 32, data: "tile" }], width: 32, height: 32 })),
  isViewerFirebaseEnabled: vi.fn(() => mockState.firebaseEnabled),
  loginViewerWithFirebase: vi.fn(),
  logoutViewerWithFirebase: vi.fn(),
  connectFirebaseSecureSession: vi.fn(),
  openFirebaseSession: vi.fn(),
  recordFirebaseInput: vi.fn(),
  registerFirstRunAgentWithFirebase: vi.fn(),
  requestFirebaseSecureSession: vi.fn(),
  sendFirebaseChatMessage: vi.fn(),
  sendFirebaseClipboardText: vi.fn(),
  updateFirebaseDeviceMetadata: vi.fn(),
  uploadFirebaseFileChunk: vi.fn(),
  uploadFirebaseFileToStorage: vi.fn(),
}));

describe("viewer API routing", () => {
  beforeEach(() => {
    mockState.firebaseEnabled = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads devices from Firestore instead of the local API when Firebase is enabled", async () => {
    const localFetch = vi.fn(async () => {
      throw new Error("local API must not be called");
    });
    vi.stubGlobal("fetch", localFetch);

    await expect(fetchDevices()).resolves.toEqual(mockState.firebaseDevices);

    expect(isViewerFirebaseEnabled).toHaveBeenCalled();
    expect(fetchFirebaseDevices).toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("keeps the local API fallback available when Firebase is explicitly disabled", async () => {
    mockState.firebaseEnabled = false;
    const localDevices: ManagedDevice[] = [{ ...mockState.firebaseDevices[0], id: "local-device" }];
    const localFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ devices: localDevices }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", localFetch);

    await expect(fetchDevices()).resolves.toEqual(localDevices);

    expect(fetchFirebaseDevices).not.toHaveBeenCalled();
    expect(localFetch).toHaveBeenCalledWith("http://127.0.0.1:8787/api/devices", {
      body: undefined,
      headers: undefined,
      method: "GET",
    });
  });

  it("signs out of Firebase when the Viewer logs out in Firebase mode", async () => {
    await logoutAdmin();

    expect(isViewerFirebaseEnabled).toHaveBeenCalled();
    expect(logoutViewerWithFirebase).toHaveBeenCalled();
  });

  it("reads stream tiles from Firestore instead of the local API when Firebase is enabled", async () => {
    const localFetch = vi.fn(async () => {
      throw new Error("local API must not be called");
    });
    vi.stubGlobal("fetch", localFetch);

    await expect(fetchTiles("session-device-1")).resolves.toMatchObject({ width: 32, height: 32 });

    expect(isViewerFirebaseEnabled).toHaveBeenCalled();
    expect(fetchFirebaseTiles).toHaveBeenCalledWith("session-device-1");
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("reads file transfer receipts from the local API when Firebase is disabled", async () => {
    mockState.firebaseEnabled = false;
    const localFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          receipts: [
            {
              transferId: "transfer-1",
              filename: "chunked.txt",
              status: "received",
              receivedChunks: 2,
              totalChunks: 2,
              updatedAt: "2026-06-16T06:00:00.000Z",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", localFetch);

    await expect(fetchFileTransferReceipts("session-device-1")).resolves.toEqual([
      {
        transferId: "transfer-1",
        filename: "chunked.txt",
        status: "received",
        receivedChunks: 2,
        totalChunks: 2,
        updatedAt: "2026-06-16T06:00:00.000Z",
      },
    ]);

    expect(fetchFirebaseFileTransferReceipts).not.toHaveBeenCalled();
    expect(localFetch).toHaveBeenCalledWith("http://127.0.0.1:8787/api/sessions/session-device-1/file-receipts", {
      body: undefined,
      headers: undefined,
      method: "GET",
    });
  });

  it("rejects oversized Firebase direct file chunks before writing Firestore documents", async () => {
    await expect(
      uploadFileChunk("session-device-1", {
        chunkIndex: 0,
        fileData: Buffer.from("chunk").toString("base64"),
        filename: "large.bin",
        isLast: false,
        totalBytes: 5 * 1024 * 1024 + 1,
        totalChunks: 2,
        transferId: "transfer-large",
      }),
    ).rejects.toThrow("Firebase direct file transfer is limited");

    expect(uploadFirebaseFileChunk).not.toHaveBeenCalled();
  });

  it("routes large Firebase file uploads through Storage instead of direct Firestore chunks", async () => {
    const onProgress = vi.fn();
    const file = new Blob(["payload"]);

    await uploadFileToStorage("session-device-1", {
      file,
      filename: "payload.bin",
      onProgress,
      totalBytes: 500 * 1024 * 1024,
      transferId: "transfer-storage",
    });

    expect(uploadFirebaseFileToStorage).toHaveBeenCalledWith("session-device-1", {
      file,
      filename: "payload.bin",
      onProgress,
      totalBytes: 500 * 1024 * 1024,
      transferId: "transfer-storage",
    });
    expect(uploadFirebaseFileChunk).not.toHaveBeenCalled();
  });

  it("does not touch Firebase sign-out when the Viewer logs out in local fallback mode", async () => {
    mockState.firebaseEnabled = false;

    await logoutAdmin();

    expect(isViewerFirebaseEnabled).toHaveBeenCalled();
    expect(logoutViewerWithFirebase).not.toHaveBeenCalled();
  });
});
