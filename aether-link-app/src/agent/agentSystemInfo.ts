import { cpus, release, totalmem } from "node:os";
import process from "node:process";
import { sanitizeDeviceSystemInfo, type DeviceSystemInfo } from "../domain/deviceSystemInfo";

interface AgentSystemInfoOptions {
  platform?: string;
  readCpus?: typeof cpus;
  readRelease?: typeof release;
  readTotalMemory?: typeof totalmem;
}

export function discoverAgentSystemInfo({
  platform = process.platform,
  readCpus = cpus,
  readRelease = release,
  readTotalMemory = totalmem,
}: AgentSystemInfoOptions = {}): DeviceSystemInfo | undefined {
  try {
    return sanitizeDeviceSystemInfo({
      cpuModel: readCpus()[0]?.model || "Unknown CPU",
      memoryBytes: readTotalMemory(),
      osVersion: formatOsVersion(platform, readRelease()),
    });
  } catch {
    return undefined;
  }
}

function formatOsVersion(platform: string, systemRelease: string): string {
  const version = systemRelease.trim();
  if (platform === "win32") {
    const [major, minor, build] = version.split(".").map(Number);
    if (major === 10 && minor === 0) {
      return (Number.isFinite(build) ? build : 0) >= 22_000 ? "Win11" : "Win10";
    }
    return new Map([
      ["6.3", "Win8.1"],
      ["6.2", "Win8"],
      ["6.1", "Win7"],
      ["6.0", "WinVista"],
      ["5.2", "WinXP"],
      ["5.1", "WinXP"],
    ]).get(`${major}.${minor}`) ?? (version ? `Windows ${version}` : "Windows");
  }

  const name = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform || "Unknown OS";
  return version ? `${name} ${version}` : name;
}
