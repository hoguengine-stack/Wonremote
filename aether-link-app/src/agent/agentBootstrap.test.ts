import { describe, expect, it, vi } from "vitest";
import { bootstrapAgent } from "./agentBootstrap";
import type { AgentBootstrapDeps, AgentLocalConfig } from "./agentBootstrap";
import type { ManagedDevice } from "../domain/types";

const registeredDevice: ManagedDevice = {
  id: "123-45-67890:AGENT-CLI-001",
  businessNumber: "123-45-67890",
  storeName: "사업자 123-45-67890",
  deviceNumber: "AGENT-CLI-001",
  deviceName: "Agent AGENT-CLI-001",
  desktopName: "DESKTOP-67890-AGENT-CLI-001",
  status: "online",
  lastSeenAt: "2026-06-11T01:00:00.000Z",
};

function createDeps(config: AgentLocalConfig | null = null): AgentBootstrapDeps {
  return {
    createInstallId: vi.fn(() => "agent-cli-001"),
    nowIso: vi.fn(() => "2026-06-11T01:00:00.000Z"),
    promptCredentials: vi.fn(async () => ({
      businessNumber: "1234567890",
      password: "1234",
    })),
    readConfig: vi.fn(async () => config),
    registerFirstRun: vi.fn(async () => ({
      devices: [registeredDevice],
      device: registeredDevice,
    })),
    writeConfig: vi.fn(async () => undefined),
  };
}

describe("agent bootstrap", () => {
  it("prompts once, registers the first-run agent, and saves local config", async () => {
    const deps = createDeps();

    const result = await bootstrapAgent(deps);

    expect(deps.promptCredentials).toHaveBeenCalledTimes(1);
    expect(deps.registerFirstRun).toHaveBeenCalledWith({
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-cli-001",
    });
    expect(deps.writeConfig).toHaveBeenCalledWith({
      businessNumber: "123-45-67890",
      installId: "agent-cli-001",
      registeredAt: "2026-06-11T01:00:00.000Z",
      registeredDeviceId: "123-45-67890:AGENT-CLI-001",
    });
    expect(result).toMatchObject({
      status: "registered",
      device: registeredDevice,
    });
  });

  it("does not prompt again when a registered local config already exists", async () => {
    const existingConfig: AgentLocalConfig = {
      businessNumber: "123-45-67890",
      installId: "agent-cli-001",
      registeredAt: "2026-06-11T01:00:00.000Z",
      registeredDeviceId: "123-45-67890:AGENT-CLI-001",
    };
    const deps = createDeps(existingConfig);

    const result = await bootstrapAgent(deps);

    expect(deps.promptCredentials).not.toHaveBeenCalled();
    expect(deps.registerFirstRun).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(result).toEqual({
      config: existingConfig,
      status: "already_registered",
    });
  });
});
