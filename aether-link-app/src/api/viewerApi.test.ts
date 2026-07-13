import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevice } from "../domain/types";
import {
  deleteFirebaseDevice,
  fetchFirebaseDevices,
  fetchFirebaseConnectionHistory,
  fetchFirebaseFileTransferReceipts,
  fetchFirebaseTiles,
  isViewerFirebaseEnabled,
  logoutViewerWithFirebase,
  uploadFirebaseFileToStorage,
  uploadFirebaseFileChunk,
} from "../firebase/viewerFirebase";
import {
  deleteRemoteDevice,
  fetchConnectionHistory,
  fetchDevices,
  fetchFileTransferReceipts,
  fetchTiles,
  logoutAdmin,
  uploadFileChunk,
  uploadFileToStorage,
} from "./viewerApi";

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
  deleteFirebaseDevice: vi.fn(),
  fetchFirebaseChatMessages: vi.fn(async () => []),
  fetchFirebaseDevices: vi.fn(async () => mockState.firebaseDevices),
  fetchFirebaseConnectionHistory: vi.fn(async () => [
    {
      id: "session-1",
      deviceId: "device-1",
      storeName: "Test Store",
      deviceName: "Counter POS",
      startedAt: "2026-07-11T00:00:00.000Z",
      status: "success",
    },
  ]),
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

  it("deletes devices through Firestore when Firebase is enabled", async () => {
    const localFetch = vi.fn(async () => {
      throw new Error("local API must not be called");
    });
    vi.stubGlobal("fetch", localFetch);

    await expect(deleteRemoteDevice("device-1")).resolves.toBeUndefined();

    expect(deleteFirebaseDevice).toHaveBeenCalledWith("device-1");
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("deletes devices through the local API fallback when Firebase is disabled", async () => {
    mockState.firebaseEnabled = false;
    const localFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }));
    vi.stubGlobal("fetch", localFetch);

    await expect(deleteRemoteDevice("device/with space")).resolves.toBeUndefined();

    expect(deleteFirebaseDevice).not.toHaveBeenCalled();
    expect(localFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/devices/device%2Fwith%20space",
      {
        body: undefined,
        headers: undefined,
        method: "DELETE",
      },
    );
  });

  it("reads connection history from Firestore without requiring the local API", async () => {
    const localFetch = vi.fn(async () => {
      throw new Error("local API must not be called");
    });
    vi.stubGlobal("fetch", localFetch);

    await expect(fetchConnectionHistory()).resolves.toHaveLength(1);

    expect(fetchFirebaseConnectionHistory).toHaveBeenCalled();
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

  it("explains local API failures as a configuration/runtime problem", async () => {
    mockState.firebaseEnabled = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));

    await expect(fetchDevices()).rejects.toThrow("Firebase 설정 또는 내장 API 실행 상태를 확인");
  });

  it("signs out of Firebase when the Viewer logs out in Firebase mode", async () => {
    await logoutAdmin();

    expect(isViewerFirebaseEnabled).toHaveBeenCalled();
    expect(logoutViewerWithFirebase).toHaveBeenCalled();
  });

  it("keeps the diagnostic Firestore tile fallback routed away from the local API", async () => {
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
