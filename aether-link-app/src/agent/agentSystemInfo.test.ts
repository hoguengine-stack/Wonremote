import { describe, expect, it } from "vitest";
import { discoverAgentSystemInfo } from "./agentSystemInfo";

const memoryBytes = 4 * 1024 ** 3;
const readCpus = () => [{ model: "Intel(R) Processor N95" }] as ReturnType<typeof import("node:os").cpus>;

describe("agent system info", () => {
  it.each([
    ["10.0.22631", "Win11"],
    ["10.0.19045", "Win10"],
    ["6.1.7601", "Win7"],
  ])("maps Windows release %s to %s", (systemRelease, osVersion) => {
    expect(discoverAgentSystemInfo({
      platform: "win32",
      readCpus,
      readRelease: () => systemRelease,
      readTotalMemory: () => memoryBytes,
    })).toEqual({
      cpuModel: "Intel(R) Processor N95",
      memoryBytes,
      osVersion,
    });
  });

  it("labels non-Windows releases without throwing", () => {
    expect(discoverAgentSystemInfo({
      platform: "linux",
      readCpus,
      readRelease: () => "6.8.0",
      readTotalMemory: () => memoryBytes,
    })?.osVersion).toBe("Linux 6.8.0");
  });

  it("returns undefined when operating-system discovery fails", () => {
    expect(() => discoverAgentSystemInfo({
      readCpus: () => { throw new Error("unavailable"); },
    })).not.toThrow();
    expect(discoverAgentSystemInfo({
      readCpus: () => { throw new Error("unavailable"); },
    })).toBeUndefined();
  });
});
