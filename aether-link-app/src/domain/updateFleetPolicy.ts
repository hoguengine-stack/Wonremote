import type { DeviceUpdateRing, DeviceUpdateState, ManagedDevice } from "./types";

export interface UpdateFleetRollout {
  targetVersion: string;
  stage: DeviceUpdateRing;
  paused?: boolean;
  percentage?: number;
}

export type UpdateEligibilityReason =
  | "eligible"
  | "paused"
  | "missing-device-id"
  | "missing-target-version"
  | "already-current"
  | "ring-not-enabled"
  | "outside-percentage";

export interface UpdateEligibilityDecision {
  eligible: boolean;
  reason: UpdateEligibilityReason;
  bucket: number;
}

export interface UpdateFleetHealthSummary {
  total: number;
  healthy: number;
  inProgress: number;
  failed: number;
  rollback: number;
  pending: number;
}

const RING_ORDER: Record<DeviceUpdateRing, number> = {
  canary: 0,
  pilot: 1,
  general: 2,
};

const IN_PROGRESS_STATES: readonly DeviceUpdateState[] = [
  "checking",
  "downloading",
  "installing",
  "restarting",
];

export function hashDeviceIdToPercentageBucket(deviceId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < deviceId.length; index += 1) {
    hash ^= deviceId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % 100;
}

export function decideUpdateEligibility(
  device: Pick<ManagedDevice, "id" | "version" | "updateCurrentVersion" | "updatePaused" | "updateRing">,
  rollout: UpdateFleetRollout,
): UpdateEligibilityDecision {
  const bucket = hashDeviceIdToPercentageBucket(device.id);
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

  const deviceRing = device.updateRing ?? "general";
  if (RING_ORDER[deviceRing] > RING_ORDER[rollout.stage]) {
    return { eligible: false, reason: "ring-not-enabled", bucket };
  }
  if (bucket >= normalizePercentage(rollout.percentage)) {
    return { eligible: false, reason: "outside-percentage", bucket };
  }
  return { eligible: true, reason: "eligible", bucket };
}

export function summarizeUpdateFleetHealth(
  devices: ReadonlyArray<Pick<ManagedDevice, "id" | "updateState">>,
): UpdateFleetHealthSummary {
  const summary: UpdateFleetHealthSummary = {
    total: devices.length,
    healthy: 0,
    inProgress: 0,
    failed: 0,
    rollback: 0,
    pending: 0,
  };

  for (const device of devices) {
    if (device.updateState === "healthy") {
      summary.healthy += 1;
    } else if (device.updateState === "failed") {
      summary.failed += 1;
    } else if (device.updateState === "rollback") {
      summary.rollback += 1;
    } else if (device.updateState && IN_PROGRESS_STATES.includes(device.updateState)) {
      summary.inProgress += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
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
