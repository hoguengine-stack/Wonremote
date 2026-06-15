import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevice } from "../domain/types";
import { fetchFirebaseDevices, isViewerFirebaseEnabled } from "../firebase/viewerFirebase";
import { fetchDevices } from "./viewerApi";

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
  fetchFirebaseDevices: vi.fn(async () => mockState.firebaseDevices),
  fetchFirebaseSessionStatus: vi.fn(),
  isViewerFirebaseEnabled: vi.fn(() => mockState.firebaseEnabled),
  loginViewerWithFirebase: vi.fn(),
  openFirebaseSession: vi.fn(),
  recordFirebaseInput: vi.fn(),
  registerFirstRunAgentWithFirebase: vi.fn(),
  updateFirebaseDeviceMetadata: vi.fn(),
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
});
