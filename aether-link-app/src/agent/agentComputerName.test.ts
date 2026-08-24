import { describe, expect, it } from "vitest";
import { resolveAgentComputerName } from "./agentComputerName";

const identity = {
  businessNumber: "123-45-67890",
  installId: "agent-abc123",
};

describe("agent computer name", () => {
  it("prefers the current Windows COMPUTERNAME over a stale stored desktop name", () => {
    expect(resolveAgentComputerName({
      ...identity,
      env: { COMPUTERNAME: "STORE-POS-01" },
      platform: "win32",
      readHostname: () => "hostname-fallback",
      storedDesktopName: "DESKTOP-67890-AGENT-ABC123",
    })).toBe("STORE-POS-01");
  });

  it("uses os.hostname when Windows COMPUTERNAME is unavailable", () => {
    expect(resolveAgentComputerName({
      ...identity,
      env: {},
      platform: "win32",
      readHostname: () => "OFFICE-PC",
    })).toBe("OFFICE-PC");
  });

  it("uses the deterministic derived fallback outside Windows", () => {
    expect(resolveAgentComputerName({
      ...identity,
      env: { COMPUTERNAME: "HOST-SPECIFIC" },
      platform: "linux",
      readHostname: () => "ci-runner-random",
      storedDesktopName: "STALE-WINDOWS-PC",
    })).toBe("DESKTOP-67890-AGENT-ABC123");
  });
});
