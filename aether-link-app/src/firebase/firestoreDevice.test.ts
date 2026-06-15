import { describe, expect, it } from "vitest";
import { buildFirestoreDevice, mapFirestoreDevice } from "./firestoreDevice";

describe("firestore device mapping", () => {
  it("builds a Firestore device document from first-run agent data", () => {
    const device = buildFirestoreDevice({
      businessNumber: "1234567890",
      installId: "agent-localenv-425d1cbe",
      ownerUid: "uid-1",
      version: "0.1.2",
      nowIso: "2026-06-12T09:00:00.000Z",
    });

    expect(device).toMatchObject({
      id: "123-45-67890:AGENT-LOCALENV-425D1CB",
      businessNumber: "123-45-67890",
      storeName: "사업자 123-45-67890",
      deviceNumber: "AGENT-LOCALENV-425D1CB",
      deviceName: "Agent AGENT-LOCALENV-425D1CB",
      ownerUid: "uid-1",
      status: "online",
      version: "0.1.2",
    });
    expect("connectionCode" in device).toBe(false);
  });

  it("maps Firestore data back to the existing ManagedDevice shape", () => {
    const managed = mapFirestoreDevice("device-1", {
      businessNumber: "123-45-67890",
      storeName: "사업자 123-45-67890",
      deviceNumber: "AGENT-01",
      deviceName: "Agent AGENT-01",
      desktopName: "DESKTOP-67890-AGENT-01",
      status: "online",
      lastSeenAt: "2026-06-12T09:00:00.000Z",
      connectionCode: "123 456",
      version: "0.1.2",
      activeDisplayIndex: 1,
      displays: [
        { index: 0, name: "DISPLAY1", width: 1024, height: 768, primary: true },
        { index: 1, name: "DISPLAY2", width: 1600, height: 900, primary: false },
      ],
    });

    expect(managed).toEqual({
      id: "device-1",
      businessNumber: "123-45-67890",
      storeName: "사업자 123-45-67890",
      deviceNumber: "AGENT-01",
      deviceName: "Agent AGENT-01",
      desktopName: "DESKTOP-67890-AGENT-01",
      status: "online",
      lastSeenAt: "2026-06-12T09:00:00.000Z",
      connectionCode: "123 456",
      version: "0.1.2",
      activeDisplayIndex: 1,
      displays: [
        { index: 0, name: "DISPLAY1", width: 1024, height: 768, primary: true },
        { index: 1, name: "DISPLAY2", width: 1600, height: 900, primary: false },
      ],
    });
  });
});
