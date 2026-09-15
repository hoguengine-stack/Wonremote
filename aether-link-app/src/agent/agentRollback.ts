import type { ProductionUpdateMetadata } from "../domain/updateManifest";

export function parseAgentRollbackRequest(action: string): { version: string; timestamp: string } | null {
  const match = /^request-rollback ((?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})) (\d{13})$/.exec(action);
  return match ? { version: match[1], timestamp: match[2] } : null;
}

export async function runPausedAgentRollback(version: string, deps: {
  hasSession: () => boolean;
  isPaused: () => Promise<boolean>;
  load: (version: string) => Promise<ProductionUpdateMetadata>;
  handoff: (metadata: ProductionUpdateMetadata, beforeLaunch: () => Promise<void>) => Promise<void>;
}): Promise<"deferred" | "handoff"> {
  if (deps.hasSession()) return "deferred";
  const requirePause = async () => {
    if (!await deps.isPaused()) throw new Error("Agent rollback requires paused automatic updates for this device.");
  };
  await requirePause();
  const metadata = await deps.load(version);
  if (deps.hasSession()) return "deferred";
  await deps.handoff(metadata, requirePause);
  return "handoff";
}
