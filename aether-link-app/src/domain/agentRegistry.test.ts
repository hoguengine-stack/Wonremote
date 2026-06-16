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
    }, "2026-06-10T01:20:00.000Z");

    expect(result.devices).toHaveLength(1);
    expect(result.device).toMatchObject({
      id: "123-45-67890:AGENT-ABC123",
      businessNumber: "123-45-67890",
      storeName: "상호명 미설정",
      deviceNumber: "AGENT-ABC123",
      deviceName: "Agent AGENT-ABC123",
      desktopName: "DESKTOP-67890-AGENT-ABC123",
      status: "online",
      lastSeenAt: "2026-06-10T01:20:00.000Z",
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
        deviceName: "Agent AGENT-TESTINSTALLID",
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
          width: 1920,
          height: 1200,
          primary: true,
        },
        {
          index: 1,
          name: "\\\\.\\DISPLAY2",
          width: 1024,
          height: 768,
          primary: false,
        },
      ],
      activeDisplayIndex: 1,
    });

    expect(heartbeat.device.displays).toEqual([
      expect.objectContaining({ index: 0, width: 1920, height: 1200, primary: true }),
      expect.objectContaining({ index: 1, width: 1024, height: 768, primary: false }),
    ]);
    expect(heartbeat.device.activeDisplayIndex).toBe(1);
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
});
