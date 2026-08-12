import { describe, expect, it, vi } from "vitest";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import type { ManagedDevice } from "../domain/types";
import {
  canRecoverMissingAgentRegistration,
  reconcileAgentRegistration,
  recoverMissingAgentRegistration,
} from "./agentRegistrationRecovery";

const recoveredDevice: ManagedDevice = {
  businessNumber: "123-45-67890",
  desktopName: "DESKTOP-67890-AGENT-82220F6D",
  deviceName: "Agent AGENT-82220F6D",
  deviceNumber: "AGENT-82220F6D",
  id: "123-45-67890:AGENT-82220F6D",
  lastSeenAt: "2026-06-16T01:00:00.000Z",
  status: "online",
  storeName: "상호명 미설정",
};

describe("agent registration recovery", () => {
  it("re-registers a Firebase device from the existing local config without prompting", async () => {
    const registerFirstRun = vi.fn(async () => ({
      device: recoveredDevice,
      devices: [recoveredDevice],
    }));
    const writeConfig = vi.fn(async () => undefined);

    const recovered = await recoverMissingAgentRegistration(
      {
        apiUrl: "http://127.0.0.1:8787",
        businessNumber: "123-45-67890",
        installId: "82220F6D",
        registeredDeviceId: "123-45-67890:AGENT-82220F6D",
        version: "0.1.16",
      },
      {
        nowIso: () => "2026-06-16T01:00:00.000Z",
        registerFirstRun,
        writeConfig,
      },
    );

    expect(registerFirstRun).toHaveBeenCalledWith({
      businessNumber: "123-45-67890",
      installId: "82220F6D",
      password: "1234",
      version: WONREMOTE_APP_VERSION,
    });
    expect(recovered).toMatchObject({
      businessNumber: "123-45-67890",
      installId: "82220F6D",
      registeredAt: "2026-06-16T01:00:00.000Z",
      registeredDeviceId: "123-45-67890:AGENT-82220F6D",
      version: WONREMOTE_APP_VERSION,
    });
    expect(writeConfig).toHaveBeenCalledWith(recovered);
  });

  it("refuses recovery when the local config does not contain enough identity", () => {
    expect(canRecoverMissingAgentRegistration({ installId: "82220F6D" })).toBe(false);
    expect(canRecoverMissingAgentRegistration({ businessNumber: "123-45-67890", installId: "82220F6D" })).toBe(true);
  });

  it("replaces a stale registered device ID with the ID derived from the local install ID", async () => {
    const registerFirstRun = vi.fn(async () => ({
      device: recoveredDevice,
      devices: [recoveredDevice],
    }));
    const writeConfig = vi.fn(async () => undefined);

    const reconciled = await reconcileAgentRegistration(
      {
        businessNumber: "123-45-67890",
        installId: "82220F6D",
        registeredDeviceId: "123-45-67890:AGENT-CBFFB65C",
      },
      {
        nowIso: () => "2026-08-12T00:00:00.000Z",
        registerFirstRun,
        writeConfig,
      },
    );

    expect(reconciled.registeredDeviceId).toBe("123-45-67890:AGENT-82220F6D");
    expect(writeConfig).toHaveBeenCalledWith(reconciled);
  });
});
