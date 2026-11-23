import type { DeviceUpdateRing, ManagedDevice } from "./types";
import { isHigherVersion } from "./versioning";

export const FIRST_SELECTED_AGENT_VERSION = "0.1.124";
const PINNED_RELEASE_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export interface UpdateFleetRollout {
  targetVersion: string;
  stage: DeviceUpdateRing;
  paused?: boolean;
  percentage?: number;
  targetDeviceIds?: string[];
}

export type UpdateEligibilityReason =
  | "eligible"
  | "missing-rollout-policy"
  | "paused"
  | "missing-device-id"
  | "missing-target-version"
  | "already-current"
  | "ring-not-enabled"
  | "outside-percentage"
  | "not-selected"
  | "invalid-selection-policy"
  | "selection-support-unknown";

export function parseRolloutSelection(value: unknown): Pick<UpdateFleetRollout, "targetDeviceIds"> {
  if (value === null || value === undefined) return {};
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== "string" || !id.trim() || id.length > 256)) {
    return {targetDeviceIds: []};
  }
  return {targetDeviceIds: [...new Set(value)]};
}

export function readUpdateRollout(data: Record<string, unknown> | undefined, selected = false): UpdateFleetRollout | null {
  if (!data) return null;
  const targetVersion = typeof data.targetVersion === "string" ? data.targetVersion.trim() : "";
  const stage = data.stage;
  if (!targetVersion || (stage !== "canary" && stage !== "pilot" && stage !== "general")) return null;
  const legacy = {
    targetVersion, stage, paused: data.paused === true,
    percentage: typeof data.percentage === "number" ? data.percentage : 100,
    ...parseRolloutSelection(data.targetDeviceIds),
  } satisfies UpdateFleetRollout;
  if (!selected) return legacy;
  if (!("selectedRollout" in data)) return legacy.targetDeviceIds === undefined ? null : legacy;
  if (!data.selectedRollout || typeof data.selectedRollout !== "object" || Array.isArray(data.selectedRollout)) return null;
  const trial = data.selectedRollout as Record<string, unknown>;
  const ids = parseRolloutSelection(trial.targetDeviceIds).targetDeviceIds;
  if (!ids?.length || typeof trial.targetVersion !== "string" || !PINNED_RELEASE_VERSION.test(trial.targetVersion)
      || typeof trial.paused !== "boolean") return null;
  return { targetVersion: trial.targetVersion, stage: "general", percentage: 0, targetDeviceIds: ids, paused: legacy.paused || trial.paused === true };
}

export function updateRolloutFields(rollout: UpdateFleetRollout) {
  const targetVersion = rollout.targetVersion.trim();
  const paused = rollout.paused === true;
  if (rollout.targetDeviceIds !== undefined) {
    return { selectedRollout: { targetVersion, paused, targetDeviceIds: parseRolloutSelection(rollout.targetDeviceIds).targetDeviceIds ?? [] } };
  }
  return { targetVersion, stage: rollout.stage, paused, percentage: normalizePercentage(rollout.percentage), targetDeviceIds: null, selectedRollout: null };
}

export function supportsSelectedAgentRollout(device: Pick<ManagedDevice, "version" | "selectedRolloutVersion">): boolean {
  return Boolean(device.version && PINNED_RELEASE_VERSION.test(device.version)
    && !isHigherVersion(FIRST_SELECTED_AGENT_VERSION, device.version) && device.selectedRolloutVersion === device.version);
}

export interface UpdateEligibilityDecision {
  eligible: boolean;
  reason: UpdateEligibilityReason;
  bucket: number;
}

const RING_ORDER: Record<DeviceUpdateRing, number> = {
  canary: 0,
  pilot: 1,
  general: 2,
};

export function hashDeviceIdToPercentageBucket(deviceId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < deviceId.length; index += 1) {
    hash ^= deviceId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % 100;
}

export function decideUpdateEligibility(
  device: Pick<ManagedDevice, "id" | "version" | "updateCurrentVersion" | "updatePaused" | "updateRing" | "selectedRolloutVersion">,
  rollout: UpdateFleetRollout | null | undefined,
): UpdateEligibilityDecision {
  const bucket = hashDeviceIdToPercentageBucket(device.id);
  if (!rollout) {
    return { eligible: false, reason: "missing-rollout-policy", bucket };
  }
  if (rollout.paused || device.updatePaused) {
    return { eligible: false, reason: "paused", bucket };
  }
  if (!device.id.trim()) {
    return { eligible: false, reason: "missing-device-id", bucket };
  }

  const targetVersion = rollout.targetVersion.trim();
  if (!targetVersion) {
    return { eligible: false, reason: "missing-target-version", bucket };
  }
  const currentVersion = (device.updateCurrentVersion ?? device.version ?? "").trim();
  if (currentVersion === targetVersion) {
    return { eligible: false, reason: "already-current", bucket };
  }

  if (rollout.targetDeviceIds !== undefined) {
    // Legacy Agents see 0% and cannot accidentally join a selected-PC rollout.
    if (rollout.percentage !== 0 || rollout.stage !== "general") {
      return {eligible: false, reason: "invalid-selection-policy", bucket};
    }
    const selected = parseRolloutSelection(rollout.targetDeviceIds).targetDeviceIds ?? [];
    if (!selected.includes(device.id)) return {eligible:false,reason:"not-selected",bucket};
    if (!supportsSelectedAgentRollout(device)) {
      return {eligible:false,reason:"selection-support-unknown",bucket};
    }
    return {eligible:true,reason:"eligible",bucket};
  }

  const deviceRing = device.updateRing ?? "general";
  if (RING_ORDER[deviceRing] > RING_ORDER[rollout.stage]) {
    return { eligible: false, reason: "ring-not-enabled", bucket };
  }
  if (bucket >= normalizePercentage(rollout.percentage)) {
    return { eligible: false, reason: "outside-percentage", bucket };
  }
  return { eligible: true, reason: "eligible", bucket };
}

function normalizePercentage(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}
