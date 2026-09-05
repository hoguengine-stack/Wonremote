import { describe, expect, it } from "vitest";
import {
  applyAgentHeartbeat,
  authenticateAdmin,
  groupDevicesByStore,
  normalizeBusinessNumber,
  registerAgentFirstRun,
  registerAgentConnection,
  updateDeviceMetadata,
} from "./agentRegistry";
import { DEFAULT_STORE_NAME } from "./deviceDefaults";

describe("agent registry domain", () => {
  it("normalizes Korean business registration numbers", () => {
    expect(normalizeBusinessNumber("1234567890")).toBe("123-45-67890");
    expect(normalizeBusinessNumber("123-45-67890")).toBe("123-45-67890");
    expect(() => normalizeBusinessNumber("1234")).toThrow("사업자번호");
  });

  it("authenticates only the local development admin", () => {
    expect(authenticateAdmin("admin", "admin1234")).toBe(true);
    expect(authenticateAdmin("admin", "1234")).toBe(false);
  });

  it("registers an agent once and opens a connected session", () => {
    const result = registerAgentConnection([], {
      businessNumber: "1234567890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "카운터",
    }, "2026-06-09T08:00:00.000Z");

    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]).toMatchObject({
      id: "123-45-67890:POS-01",
      businessNumber: "123-45-67890",
      storeName: "강남 1호점",
      storeNameSource: "user",
      deviceNumber: "POS-01",
      deviceName: "카운터",
      desktopName: "DESKTOP-67890-POS-01",
      status: "online",
    });
    expect(result.session).toMatchObject({
      id: "session-123-45-67890:POS-01",
      deviceId: "123-45-67890:POS-01",
      state: "connected",
    });
  });

  it("throws if agent password is not 1234", () => {
    expect(() =>
      registerAgentConnection([], {
        businessNumber: "1234567890",
        password: "wrong",
        storeName: "강남 1호점",
        deviceNumber: "POS-01",
        deviceName: "카운터",
      }),
    ).toThrow("비밀번호가 올바르지 않습니다.");
  });

  it("registers a first-run agent with only account credentials and install id", () => {
    const result = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-abc123",
      protocolVersion: 2,
    }, "2026-06-10T01:20:00.000Z");

    expect(result.devices).toHaveLength(1);
    expect(result.device).toMatchObject({
      id: "123-45-67890:AGENT-ABC123",
      businessNumber: "123-45-67890",
      storeName: "상호명 미설정",
      deviceNumber: "AGENT-ABC123",
      deviceName: "메인포스",
      desktopName: "DESKTOP-67890-AGENT-ABC123",
      status: "online",
      lastSeenAt: "2026-06-10T01:20:00.000Z",
      protocolVersion: 2,
    });
  });

  it("updates an existing agent instead of duplicating it", () => {
    const first = registerAgentConnection([], {
      businessNumber: "1234567890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "카운터",
    }, "2026-06-09T08:00:00.000Z");

    const second = registerAgentConnection(first.devices, {
      businessNumber: "123-45-67890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "메인 카운터",
    }, "2026-06-09T08:05:00.000Z");

    expect(second.devices).toHaveLength(1);
    expect(second.devices[0].deviceName).toBe("메인 카운터");
    expect(second.devices[0].lastSeenAt).toBe("2026-06-09T08:05:00.000Z");
  });

  it("groups registered devices by store name", () => {
    const first = registerAgentConnection([], {
      businessNumber: "1234567890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "카운터",
    }, "2026-06-09T08:00:00.000Z");
    const second = registerAgentConnection(first.devices, {
      businessNumber: "1112233333",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "KIOSK-02",
      deviceName: "키오스크",
    }, "2026-06-09T08:01:00.000Z");

    expect(groupDevicesByStore(second.devices)).toEqual([
      {
        storeName: "강남 1호점",
        devices: expect.arrayContaining([
          expect.objectContaining({ deviceNumber: "POS-01" }),
          expect.objectContaining({ deviceNumber: "KIOSK-02" }),
        ]),
      },
    ]);
  });

  it("updates display metadata without changing the agent connection identity or business number", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-edit-meta",
    }, "2026-06-10T01:20:00.000Z");

    const result = updateDeviceMetadata(registered.devices, {
      deviceId: registered.device.id,
      businessNumber: "9998877777",
      storeName: "Won Chicken Gangnam",
      deviceName: "Main POS",
      desktopName: "FRONT-DESK-PC",
    });

    expect(result.device).toMatchObject({
      id: "123-45-67890:AGENT-EDIT-META",
      businessNumber: "123-45-67890",
      storeName: "Won Chicken Gangnam",
      deviceNumber: "AGENT-EDIT-META",
      deviceName: "Main POS",
      desktopName: "FRONT-DESK-PC",
    });
    expect(result.device.id).toBe(registered.device.id);
    expect(result.device.deviceNumber).toBe(registered.device.deviceNumber);
  });

  it("normalizes legacy placeholder store names during display metadata updates", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-edit-placeholder",
    }, "2026-06-10T01:20:00.000Z");

    const result = updateDeviceMetadata(registered.devices, {
      deviceId: registered.device.id,
      storeName: "??? 123-45-67890",
      deviceName: "Main POS",
      desktopName: "FRONT-DESK-PC",
    });

    expect(result.device).toMatchObject({
      storeName: DEFAULT_STORE_NAME,
      storeNameSource: "default",
      deviceName: "Main POS",
      desktopName: "FRONT-DESK-PC",
    });
  });

  it("sanitizes operational metadata and removes fields when blank values are saved", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-ops-meta",
    });
    const updated = updateDeviceMetadata(registered.devices, {
      deviceId: registered.device.id,
      contactName: `  ${"C".repeat(120)}  `,
      installLocation: `  ${"L".repeat(300)}  `,
      tags: [" kiosk ", "KIOSK", "", ...Array.from({ length: 25 }, (_, index) => `tag-${index}`)],
      notes: `  ${"N".repeat(2_100)}  `,
    });

    expect(updated.device.contactName).toHaveLength(100);
    expect(updated.device.installLocation).toHaveLength(255);
    expect(updated.device.tags).toHaveLength(20);
    expect(updated.device.tags?.slice(0, 2)).toEqual(["kiosk", "tag-0"]);
    expect(updated.device.notes).toHaveLength(2_000);

    const cleared = updateDeviceMetadata(updated.devices, {
      deviceId: registered.device.id,
      contactName: "   ",
      installLocation: "\t",
      tags: [" ", ""],
      notes: "\n",
    });
    expect(cleared.device).not.toHaveProperty("contactName");
    expect(cleared.device).not.toHaveProperty("installLocation");
    expect(cleared.device).not.toHaveProperty("tags");
    expect(cleared.device).not.toHaveProperty("notes");
  });

  it("preserves operational metadata when the same Agent registers again", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-ops-preserve",
    });
    const edited = updateDeviceMetadata(registered.devices, {
      deviceId: registered.device.id,
      contactName: "Kim",
      installLocation: "Front counter",
      tags: ["pos", "priority"],
      notes: "Printer issue history",
    });

    const repeated = registerAgentFirstRun(edited.devices, {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-ops-preserve",
    });

    expect(repeated.device).toMatchObject({
      contactName: "Kim",
      installLocation: "Front counter",
      tags: ["pos", "priority"],
      notes: "Printer issue history",
    });
  });

  describe("agent first-run registration", () => {
    it("registers a new agent with proper auto-derived details", () => {
      const result = registerAgentFirstRun([], {
        businessNumber: "1234567890",
        password: "1234",
        installId: "agent-testinstallid",
      }, "2026-06-09T08:00:00.000Z");

      expect(result.devices).toHaveLength(1);
      expect(result.device).toMatchObject({
        businessNumber: "123-45-67890",
        deviceNumber: "AGENT-TESTINSTALLID",
        desktopName: "DESKTOP-67890-AGENT-TESTINSTALLID",
        storeName: "상호명 미설정",
        deviceName: "메인포스",
      });
    });

    it("throws if password is not 1234 on first-run", () => {
      expect(() =>
        registerAgentFirstRun([], {
          businessNumber: "1234567890",
          password: "wrong",
          installId: "agent-testinstallid",
        }),
      ).toThrow("비밀번호가 올바르지 않습니다.");
    });
  });

  it("updates display inventory from agent heartbeat", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-display-01",
    });

    const heartbeat = applyAgentHeartbeat(registered.devices, {
      deviceId: registered.device.id,
      installId: "agent-display-01",
      displays: [
        {
          index: 0,
          name: "\\\\.\\DISPLAY1",
          x: 0,
          y: 0,
          width: 1920,
          height: 1200,
          primary: true,
        },
        {
          index: 1,
          name: "\\\\.\\DISPLAY2",
          x: -1024,
          y: 0,
          width: 1024,
          height: 768,
          primary: false,
        },
      ],
      activeDisplayIndex: 1,
    });

    expect(heartbeat.device.displays).toEqual([
      expect.objectContaining({ index: 0, x: 0, y: 0, width: 1920, height: 1200, primary: true }),
      expect.objectContaining({ index: 1, x: -1024, y: 0, width: 1024, height: 768, primary: false }),
    ]);
    expect(heartbeat.device.activeDisplayIndex).toBe(1);
  });

  it("updates the desktop name from the Agent-reported Windows computer name", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-hostname",
    });

    const heartbeat = applyAgentHeartbeat(registered.devices, {
      deviceId: registered.device.id,
      installId: "agent-hostname",
      desktopName: "DESKTOP-CADI3TD",
    });

    expect(heartbeat.device.desktopName).toBe("DESKTOP-CADI3TD");
  });

  it("stores sanitized system information from agent heartbeat", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-system-info",
    });

    const heartbeat = applyAgentHeartbeat(registered.devices, {
      deviceId: registered.device.id,
      installId: "agent-system-info",
      systemInfo: {
        cpuModel: " Intel(R) Processor N95 ",
        memoryBytes: 4 * 1024 ** 3,
        osVersion: " Win10 ",
      },
    });

    expect(heartbeat.device.systemInfo).toEqual({
      cpuModel: "Intel(R) Processor N95",
      memoryBytes: 4 * 1024 ** 3,
      osVersion: "Win10",
    });
  });

  it("updates the advertised remote protocol and preserves it on malformed heartbeats", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-protocol",
      protocolVersion: 1,
    });

    const upgraded = applyAgentHeartbeat(registered.devices, {
      deviceId: registered.device.id,
      installId: "agent-protocol",
      protocolVersion: 2,
    });
    expect(upgraded.device.protocolVersion).toBe(2);

    const preserved = applyAgentHeartbeat(upgraded.devices, {
      deviceId: registered.device.id,
      installId: "agent-protocol",
      protocolVersion: Number.NaN,
    });
    expect(preserved.device.protocolVersion).toBe(2);
  });

  it("stores sanitized MAC addresses from heartbeat for Wake-on-LAN", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-woltest",
    });

    const heartbeat = applyAgentHeartbeat(registered.devices, {
      deviceId: registered.device.id,
      installId: "agent-woltest",
      macAddresses: [
        "01-23-45-67-89-ab",
        "01:23:45:67:89:AB",
        "00:00:00:00:00:00",
        "not-a-mac",
      ],
    });

    expect(heartbeat.device.macAddresses).toEqual(["01:23:45:67:89:AB"]);
  });

  it("stores sanitized stream diagnostics from heartbeat", () => {
    const registered = registerAgentFirstRun([], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-streamdiag",
    });

    const heartbeat = applyAgentHeartbeat(registered.devices, {
      deviceId: registered.device.id,
      installId: "agent-streamdiag",
      streamDiagnostics: {
        backend: "gdi",
        desired: true,
        running: false,
        restartCount: 3.8,
        loopSleepMs: 125.9,
        outputIndex: 1.2,
        lastFrameAt: "2026-06-16T06:30:00.000Z",
        lastError: "DXGI access denied",
        transport: "firestore-fallback",
        rtcState: "unavailable",
        rtcError: "node-datachannel unavailable",
      },
    });

    expect(heartbeat.device.streamDiagnostics).toEqual({
      backend: "gdi",
      desired: true,
      running: false,
      restartCount: 3,
      loopSleepMs: 125,
      outputIndex: 1,
      lastFrameAt: "2026-06-16T06:30:00.000Z",
      lastError: "DXGI access denied",
      transport: "firestore-fallback",
      rtcState: "unavailable",
      rtcError: "node-datachannel unavailable",
    });
  });

  describe("local agent metadata preservation & correction", () => {
    it("preserves user-defined store name on agent re-registration (first-run)", () => {
      const step1 = registerAgentFirstRun([], {
        businessNumber: "1234567890",
        password: "1234",
        installId: "agent-local-preserve",
      });
      expect(step1.device.storeName).toBe("상호명 미설정");
      expect(step1.device.storeNameSource).toBe("default");

      const step2 = updateDeviceMetadata(step1.devices, {
        deviceId: step1.device.id,
        storeName: "수동 입력 상호명",
      });
      expect(step2.device.storeName).toBe("수동 입력 상호명");
      expect(step2.device.storeNameSource).toBe("user");

      const step3 = registerAgentFirstRun(step2.devices, {
        businessNumber: "1234567890",
        password: "1234",
        installId: "agent-local-preserve",
      });
      expect(step3.device.storeName).toBe("수동 입력 상호명");
      expect(step3.device.storeNameSource).toBe("user");
    });

    it("corrects legacy auto-generated store names (사업자 / ???) on agent re-registration", () => {
      const mockLegacyDevice = {
        id: "123-45-67890:AGENT-LEGACY",
        businessNumber: "123-45-67890",
        storeName: "??? 123-45-67890",
        deviceNumber: "AGENT-LEGACY",
        deviceName: "Agent AGENT-LEGACY",
        desktopName: "DESKTOP-LEGACY",
        status: "online" as const,
        lastSeenAt: new Date().toISOString(),
      };

      const result = registerAgentFirstRun([mockLegacyDevice], {
        businessNumber: "1234567890",
        password: "1234",
        installId: "agent-legacy",
      });

      expect(result.device.storeName).toBe("상호명 미설정");
      expect(result.device.storeNameSource).toBe("default");
    });
  });
});

describe("agent registry store name legacy correction", () => {
  it("corrects Korean business-number placeholder store names on first-run re-registration", () => {
    const legacyBusinessPlaceholderDevice = {
      id: "123-45-67890:AGENT-BIZPLACE",
      businessNumber: "123-45-67890",
      storeName: "사업자 123-45-67890",
      storeNameSource: "user" as const,
      deviceNumber: "AGENT-BIZPLACE",
      deviceName: "Agent AGENT-BIZPLACE",
      desktopName: "DESKTOP-BIZPLACE",
      status: "online" as const,
      lastSeenAt: "2026-06-10T01:20:00.000Z",
    };

    const result = registerAgentFirstRun([legacyBusinessPlaceholderDevice], {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-bizplace",
    });

    expect(result.device.storeName).toBe(DEFAULT_STORE_NAME);
    expect(result.device.storeNameSource).toBe("default");
  });
});

describe("agent registry heartbeat store name correction", () => {
  it("corrects Korean business-number placeholder store names during heartbeat updates", () => {
    const legacyBusinessPlaceholderDevice = {
      id: "123-45-67890:AGENT-BIZPLACE",
      businessNumber: "123-45-67890",
      storeName: "사업자 123-45-67890",
      storeNameSource: "user" as const,
      deviceNumber: "AGENT-BIZPLACE",
      deviceName: "Agent AGENT-BIZPLACE",
      desktopName: "DESKTOP-BIZPLACE",
      status: "online" as const,
      lastSeenAt: "2026-06-10T01:20:00.000Z",
    };

    const heartbeat = applyAgentHeartbeat([legacyBusinessPlaceholderDevice], {
      deviceId: "123-45-67890:AGENT-BIZPLACE",
      installId: "agent-bizplace",
    });

    expect(heartbeat.device.storeName).toBe(DEFAULT_STORE_NAME);
    expect(heartbeat.device.storeNameSource).toBe("default");
  });
});
