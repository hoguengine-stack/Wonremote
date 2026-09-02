export const CURRENT_REMOTE_PROTOCOL_VERSION = 2;
export const MIN_SUPPORTED_REMOTE_PROTOCOL_VERSION = 1;

export type RemoteProtocolCompatibility = "current" | "legacy" | "unsupported-old" | "unsupported-new";

export interface RemoteProtocolDecision {
  compatible: boolean;
  effectiveVersion: number;
  state: RemoteProtocolCompatibility;
}

export function evaluateRemoteProtocolCompatibility(value: unknown): RemoteProtocolDecision {
  const effectiveVersion = normalizeRemoteProtocolVersion(value);
  if (effectiveVersion < MIN_SUPPORTED_REMOTE_PROTOCOL_VERSION) {
    return { compatible: false, effectiveVersion, state: "unsupported-old" };
  }
  if (effectiveVersion > CURRENT_REMOTE_PROTOCOL_VERSION) {
    return { compatible: false, effectiveVersion, state: "unsupported-new" };
  }
  return {
    compatible: true,
    effectiveVersion,
    state: effectiveVersion === CURRENT_REMOTE_PROTOCOL_VERSION ? "current" : "legacy",
  };
}

// Devices installed before protocol advertisement used the original v1 contract.
export function normalizeRemoteProtocolVersion(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : MIN_SUPPORTED_REMOTE_PROTOCOL_VERSION;
}

export function remoteProtocolErrorMessage(decision: RemoteProtocolDecision): string {
  if (decision.state === "unsupported-new") {
    return `Agent protocol v${decision.effectiveVersion} is newer than this Viewer. Update the Viewer first.`;
  }
  if (decision.state === "unsupported-old") {
    return `Agent protocol v${decision.effectiveVersion} is no longer supported. Update the Agent first.`;
  }
  return "";
}
