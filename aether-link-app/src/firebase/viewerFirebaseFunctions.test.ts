import { beforeEach, describe, expect, it, vi } from "vitest";
import { httpsCallable } from "firebase/functions";
import {
  closeFirebaseSession,
  connectFirebaseSecureSession,
  openFirebaseSession,
  recordFirebaseInput,
  requestFirebaseSecureSession,
  wakeFirebaseDevice,
} from "./viewerFirebase";

const mockState = vi.hoisted(() => ({
  callables: new Map<string, ReturnType<typeof vi.fn>>(),
  services: {
    auth: {},
    db: {},
    functions: { app: "functions" },
  },
}));
const callableEnv = { VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE: "callable" } as ImportMetaEnv;

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

vi.mock("firebase/functions", () => ({
  httpsCallable: vi.fn((_functions: unknown, name: string) => {
    const callable = mockState.callables.get(name);
    if (!callable) {
      throw new Error(`Unexpected callable: ${name}`);
    }
    return callable;
  }),
}));

describe("Firebase callable viewer controls", () => {
  beforeEach(() => {
    mockState.callables.clear();
    vi.clearAllMocks();
  });

  it("requests secure session challenges through Cloud Functions", async () => {
    const requestSecureSession = vi.fn(async () => ({
      data: {
        challengeId: "secure-1",
        expiresAt: "2026-06-16T08:00:00.000Z",
      },
    }));
    mockState.callables.set("requestSecureSession", requestSecureSession);

    await expect(requestFirebaseSecureSession("device-1", callableEnv)).resolves.toEqual({
      challengeId: "secure-1",
      expiresAt: "2026-06-16T08:00:00.000Z",
    });

    expect(httpsCallable).toHaveBeenCalledWith(mockState.services.functions, "requestSecureSession");
    expect(requestSecureSession).toHaveBeenCalledWith({ deviceId: "device-1" });
  });

  it("connects secure sessions through Cloud Functions", async () => {
    const connectSecureSession = vi.fn(async () => ({
      data: {
        inputLog: ["start-stream queued"],
        session: {
          deviceId: "device-1",
          id: "session-device-1",
          startedAt: "2026-06-16T08:00:00.000Z",
          state: "connected",
        },
      },
    }));
    mockState.callables.set("connectSecureSession", connectSecureSession);

    await expect(
      connectFirebaseSecureSession({
        challengeId: "secure-1",
        code: "123 456",
        deviceId: "device-1",
      }, callableEnv),
    ).resolves.toMatchObject({ session: { id: "session-device-1" } });

    expect(httpsCallable).toHaveBeenCalledWith(mockState.services.functions, "connectSecureSession");
    expect(connectSecureSession).toHaveBeenCalledWith({
      challengeId: "secure-1",
      code: "123 456",
      deviceId: "device-1",
    });
  });

  it("routes normal session open, input, and close through Cloud Functions", async () => {
    const openSession = vi.fn(async () => ({
      data: {
        inputLog: ["start-stream queued"],
        session: {
          deviceId: "device-1",
          id: "session-device-1",
          startedAt: "2026-06-16T08:00:00.000Z",
          state: "connected",
        },
      },
    }));
    const enqueueCommand = vi.fn(async () => ({ data: { inputLog: ["click 1 2"] } }));
    const closeSession = vi.fn(async () => ({ data: null }));
    mockState.callables.set("openSession", openSession);
    mockState.callables.set("enqueueCommand", enqueueCommand);
    mockState.callables.set("closeSession", closeSession);

    await expect(openFirebaseSession("device-1", callableEnv)).resolves.toMatchObject({ session: { id: "session-device-1" } });
    await expect(recordFirebaseInput("session-device-1", "click 1 2", callableEnv)).resolves.toEqual(["click 1 2"]);
    await expect(closeFirebaseSession("session-device-1", callableEnv)).resolves.toBeUndefined();

    expect(openSession).toHaveBeenCalledWith({ deviceId: "device-1" });
    expect(enqueueCommand).toHaveBeenCalledWith({ action: "click 1 2", sessionId: "session-device-1" });
    expect(closeSession).toHaveBeenCalledWith({ sessionId: "session-device-1" });
  });

  it("routes Wake-on-LAN through the authenticated relay function", async () => {
    const wakeDevice = vi.fn(async () => ({
      data: {
        relayDeviceId: "relay-1",
        targetDeviceId: "device-1",
        targetMac: "AA:BB:CC:DD:EE:FF",
      },
    }));
    mockState.callables.set("wakeDevice", wakeDevice);

    await expect(wakeFirebaseDevice("device-1", "AA:BB:CC:DD:EE:FF", callableEnv)).resolves.toEqual({
      relayDeviceId: "relay-1",
      targetDeviceId: "device-1",
      targetMac: "AA:BB:CC:DD:EE:FF",
    });
    expect(httpsCallable).toHaveBeenCalledWith(mockState.services.functions, "wakeDevice");
    expect(wakeDevice).toHaveBeenCalledWith({
      targetDeviceId: "device-1",
      targetMac: "AA:BB:CC:DD:EE:FF",
    });
  });
});
