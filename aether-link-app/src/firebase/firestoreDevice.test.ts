import { describe, expect, it } from "vitest";
import { buildFirestoreDevice, mapFirestoreDevice, mergeFirstRunDeviceDocument } from "./firestoreDevice";

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
      storeName: "상호명 미설정",
      deviceNumber: "AGENT-LOCALENV-425D1CB",
      deviceName: "Agent AGENT-LOCALENV-425D1CB",
      ownerUid: "uid-1",
      status: "online",
      storeNameSource: "default",
      version: "0.1.2",
    });
    expect("connectionCode" in device).toBe(false);
  });

  it("maps Firestore data back to the existing ManagedDevice shape", () => {
    const managed = mapFirestoreDevice("device-1", {
      businessNumber: "123-45-67890",
      storeName: "강남 1호점",
      deviceNumber: "AGENT-01",
      deviceName: "Agent AGENT-01",
      desktopName: "DESKTOP-67890-AGENT-01",
      status: "online",
      lastSeenAt: "2026-06-12T09:00:00.000Z",
      connectionCode: "123 456",
      version: "0.1.2",
      activeDisplayIndex: 1,
      displays: [
        { index: 0, name: "DISPLAY1", x: 0, y: 0, width: 1024, height: 768, primary: true },
        { index: 1, name: "DISPLAY2", x: 1024, y: 0, width: 1600, height: 900, primary: false },
      ],
      streamDiagnostics: {
        backend: "gdi",
        desired: true,
        running: false,
        restartCount: 2.9,
        loopSleepMs: 125.7,
        outputIndex: 1.8,
        lastFrameAt: "2026-06-16T06:30:00.000Z",
        lastError: `  ${"DXGI access denied ".repeat(40)}`,
        transport: "firestore-fallback",
        rtcState: "unavailable",
        rtcError: `  ${"node-datachannel unavailable ".repeat(40)}`,
      },
    });

    expect(managed).toEqual({
      id: "device-1",
      businessNumber: "123-45-67890",
      storeName: "강남 1호점",
      deviceNumber: "AGENT-01",
      deviceName: "Agent AGENT-01",
      desktopName: "DESKTOP-67890-AGENT-01",
      status: "online",
      lastSeenAt: "2026-06-12T09:00:00.000Z",
      connectionCode: "123 456",
      version: "0.1.2",
      activeDisplayIndex: 1,
      displays: [
        { index: 0, name: "DISPLAY1", x: 0, y: 0, width: 1024, height: 768, primary: true },
        { index: 1, name: "DISPLAY2", x: 1024, y: 0, width: 1600, height: 900, primary: false },
      ],
      streamDiagnostics: {
        backend: "gdi",
        desired: true,
        running: false,
        restartCount: 2,
        loopSleepMs: 125,
        outputIndex: 1,
        lastFrameAt: "2026-06-16T06:30:00.000Z",
        lastError: "DXGI access denied ".repeat(40).trim().slice(0, 500),
        transport: "firestore-fallback",
        rtcState: "unavailable",
        rtcError: "node-datachannel unavailable ".repeat(40).trim().slice(0, 500),
      },
    });
  });

  it("coerces optional update telemetry without creating undefined fields", () => {
    const managed = mapFirestoreDevice("device-update", {
      businessNumber: "123-45-67890",
      storeName: "Won Chicken Gangnam",
      storeNameSource: "user",
      deviceNumber: "AGENT-01",
      deviceName: "Agent AGENT-01",
      desktopName: "DESKTOP-67890-AGENT-01",
      status: "online",
      lastSeenAt: "2026-06-12T09:00:00.000Z",
      updateState: "downloading",
      updateTargetVersion: " 1.2.0 ",
      updateCurrentVersion: " 1.1.0 ",
      updateProgress: 101.8,
      updateError: `  ${"network timeout ".repeat(40)}`,
      updateUpdatedAt: { toDate: () => new Date("2026-06-16T06:30:00.000Z") },
      updateRing: "pilot",
      updatePaused: true,
    });

    expect(managed).toMatchObject({
      storeName: "Won Chicken Gangnam",
      updateState: "downloading",
      updateTargetVersion: "1.2.0",
      updateCurrentVersion: "1.1.0",
      updateProgress: 100,
      updateError: "network timeout ".repeat(40).trim().slice(0, 500),
      updateUpdatedAt: "2026-06-16T06:30:00.000Z",
      updateRing: "pilot",
      updatePaused: true,
    });
    expect(Object.values(managed)).not.toContain(undefined);

    const invalid = mapFirestoreDevice("device-invalid-update", {
      businessNumber: "123-45-67890",
      storeName: "Won Chicken Gangnam",
      deviceNumber: "AGENT-02",
      deviceName: "Agent AGENT-02",
      desktopName: "DESKTOP-67890-AGENT-02",
      status: "online",
      lastSeenAt: "2026-06-12T09:00:00.000Z",
      updateState: "unknown",
      updateProgress: Number.NaN,
      updateRing: "invalid",
      updatePaused: "true" as never,
    });
    expect(invalid).not.toHaveProperty("updateState");
    expect(invalid).not.toHaveProperty("updateProgress");
    expect(invalid).not.toHaveProperty("updateRing");
    expect(invalid).not.toHaveProperty("updatePaused");
  });

  it("preserves user-edited display fields when first-run registration repeats", () => {
    const nextDevice = buildFirestoreDevice({
      businessNumber: "1234567890",
      installId: "agent-localenv-425d1cbe",
      ownerUid: "uid-1",
      version: "0.1.21",
      nowIso: "2026-06-16T06:00:00.000Z",
    });

    const merged = mergeFirstRunDeviceDocument(nextDevice, {
      businessNumber: "123-45-67890",
      storeName: "Won Chicken Gangnam",
      storeNameSource: "user",
      deviceName: "Kitchen POS",
      desktopName: "KITCHEN-PC",
      deviceNumber: "AGENT-LOCALENV-425D1CB",
      status: "online",
      lastSeenAt: "2026-06-15T00:00:00.000Z",
    });

    expect(merged).toMatchObject({
      storeName: "Won Chicken Gangnam",
      storeNameSource: "user",
      deviceName: "Kitchen POS",
      desktopName: "KITCHEN-PC",
      status: "online",
      lastSeenAt: "2026-06-16T06:00:00.000Z",
      version: "0.1.21",
    });
  });

  it("normalizes legacy generated store names for display", () => {
    expect(
      mapFirestoreDevice("device-legacy", {
        businessNumber: "123-45-67890",
        storeName: "사업자 123-45-67890",
        deviceNumber: "AGENT-01",
        deviceName: "Agent AGENT-01",
        desktopName: "DESKTOP-67890-AGENT-01",
        status: "online",
        lastSeenAt: "2026-06-12T09:00:00.000Z",
      }).storeName,
    ).toBe("상호명 미설정");

    expect(
      mapFirestoreDevice("device-mojibake", {
        businessNumber: "123-45-67890",
        storeName: "??? 123-45-67890",
        deviceNumber: "AGENT-01",
        deviceName: "Agent AGENT-01",
        desktopName: "DESKTOP-67890-AGENT-01",
        status: "online",
        lastSeenAt: "2026-06-12T09:00:00.000Z",
      }).storeName,
    ).toBe("상호명 미설정");

    expect(
      mapFirestoreDevice("device-user-placeholder", {
        businessNumber: "123-45-67890",
        storeName: "사업자 123-45-67890",
        storeNameSource: "user",
        deviceNumber: "AGENT-01",
        deviceName: "Agent AGENT-01",
        desktopName: "DESKTOP-67890-AGENT-01",
        status: "online",
        lastSeenAt: "2026-06-12T09:00:00.000Z",
      }).storeName,
    ).toBe("상호명 미설정");
  });

  it("preserves legacy user-customized store name when storeNameSource is missing", () => {
    const nextDevice = buildFirestoreDevice({
      businessNumber: "1234567890",
      installId: "agent-localenv-425d1cbe",
      ownerUid: "uid-1",
      version: "0.1.21",
      nowIso: "2026-06-16T06:00:00.000Z",
    });

    const merged = mergeFirstRunDeviceDocument(nextDevice, {
      businessNumber: "123-45-67890",
      storeName: "대박치킨",
      deviceNumber: "AGENT-LOCALENV-425D1CB",
      status: "online",
      lastSeenAt: "2026-06-15T00:00:00.000Z",
    });

    expect(merged).toMatchObject({
      storeName: "대박치킨",
      storeNameSource: "user",
    });
  });

  it("does NOT preserve legacy generated store name when storeNameSource is missing", () => {
    const nextDevice = buildFirestoreDevice({
      businessNumber: "1234567890",
      installId: "agent-localenv-425d1cbe",
      ownerUid: "uid-1",
      version: "0.1.21",
      nowIso: "2026-06-16T06:00:00.000Z",
    });

    const merged = mergeFirstRunDeviceDocument(nextDevice, {
      businessNumber: "123-45-67890",
      storeName: "??? 123-45-67890",
      deviceNumber: "AGENT-LOCALENV-425D1CB",
      status: "online",
      lastSeenAt: "2026-06-15T00:00:00.000Z",
    });

    expect(merged).toMatchObject({
      storeName: "상호명 미설정",
      storeNameSource: "default",
    });
  });

  it("does NOT preserve legacy generated store name even when storeNameSource says user", () => {
    const nextDevice = buildFirestoreDevice({
      businessNumber: "1234567890",
      installId: "agent-localenv-425d1cbe",
      ownerUid: "uid-1",
      version: "0.1.21",
      nowIso: "2026-06-16T06:00:00.000Z",
    });

    const merged = mergeFirstRunDeviceDocument(nextDevice, {
      businessNumber: "123-45-67890",
      storeName: "??? 123-45-67890",
      storeNameSource: "user",
      deviceNumber: "AGENT-LOCALENV-425D1CB",
      status: "online",
      lastSeenAt: "2026-06-15T00:00:00.000Z",
    });

    expect(merged).toMatchObject({
      storeName: "상호명 미설정",
      storeNameSource: "default",
    });
  });
});
