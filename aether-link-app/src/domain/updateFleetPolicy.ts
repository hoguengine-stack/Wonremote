import type { DeviceUpdateRing, ManagedDevice } from "./types";

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
    if (!device.version || device.selectedRolloutVersion !== device.version) {
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
