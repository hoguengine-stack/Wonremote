import { readFile } from "node:fs/promises";
import type { AgentUpdateTelemetry, DeviceUpdateState } from "../domain/types";

const RESULT_STATES = new Set<DeviceUpdateState>(["healthy", "rollback", "failed"]);

export async function loadInstallerUpdateResult(
  resultPath: string,
  currentVersion: string,
): Promise<AgentUpdateTelemetry | null> {
  const content = await readFile(resultPath, "utf8").catch(() => "");
  if (!content) return null;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (!RESULT_STATES.has(value.state as DeviceUpdateState)) return null;
    return {
      currentVersion,
      state: value.state as DeviceUpdateState,
      progress: value.state === "healthy" ? 100 : 0,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
      ...(typeof value.targetVersion === "string" && value.targetVersion.trim() ? { targetVersion: value.targetVersion.trim() } : {}),
      ...(typeof value.error === "string" && value.error.trim() ? { error: value.error.trim().slice(0, 500) } : {}),
    };
  } catch {
    return null;
  }
}
