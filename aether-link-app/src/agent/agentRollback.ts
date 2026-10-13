import type { ProductionUpdateMetadata } from "../domain/updateManifest";
import { isHigherVersion } from "../domain/versioning";

export function parseAgentRollbackRequest(action: string): { version: string; timestamp: string } | null {
  const match = /^request-rollback ((?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})) (\d{13})$/.exec(action);
  return match ? { version: match[1], timestamp: match[2] } : null;
}

export async function runPausedAgentRollback(version: string, deps: {
  hasSession: () => boolean;
  isPaused: () => Promise<boolean>;
  load: (version: string) => Promise<ProductionUpdateMetadata>;
  handoff: (metadata: ProductionUpdateMetadata, beforeLaunch: () => Promise<void>) => Promise<void>;
  minimumVersion?: () => string | null;
}): Promise<"deferred" | "handoff"> {
  if (deps.hasSession()) return "deferred";
  const requirePause = async () => {
    const minimumVersion = deps.minimumVersion?.();
    if (minimumVersion && isHigherVersion(minimumVersion, version)) throw new Error("잠금 장비는 접속 잠금을 지원하지 않는 버전으로 복구할 수 없습니다. 먼저 잠금을 해제하세요.");
    if (!await deps.isPaused()) throw new Error("Agent rollback requires paused automatic updates for this device.");
  };
  await requirePause();
  const metadata = await deps.load(version);
  if (deps.hasSession()) return "deferred";
  await deps.handoff(metadata, requirePause);
  return "handoff";
}
