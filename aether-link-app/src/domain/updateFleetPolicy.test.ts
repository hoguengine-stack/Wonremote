import { describe, expect, it } from "vitest";
import {
  decideUpdateEligibility,
  hashDeviceIdToPercentageBucket,
  summarizeUpdateFleetHealth,
} from "./updateFleetPolicy";

describe("update fleet policy", () => {
  const rollout = {
    targetVersion: "1.2.0",
    stage: "pilot" as const,
    percentage: 100,
  };

  it("gates rollout eligibility by pause, stage, and target version", () => {
    expect(decideUpdateEligibility({ id: "canary-1", updateRing: "canary", version: "1.1.0" }, rollout)).toMatchObject({
      eligible: true,
    });
    expect(decideUpdateEligibility({ id: "general-1", updateRing: "general", version: "1.1.0" }, rollout)).toMatchObject({
      eligible: false,
      reason: "ring-not-enabled",
    });
    expect(decideUpdateEligibility({ id: "paused-1", updatePaused: true, version: "1.1.0" }, rollout)).toMatchObject({
      eligible: false,
      reason: "paused",
    });
    expect(decideUpdateEligibility({ id: "current-1", version: "1.2.0" }, rollout)).toMatchObject({
      eligible: false,
      reason: "already-current",
    });
  });

  it("uses a stable device-id percentage bucket", () => {
    const id = "stable-device";
    const bucket = hashDeviceIdToPercentageBucket(id);

    expect(bucket).toBe(hashDeviceIdToPercentageBucket(id));
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(decideUpdateEligibility({ id, updateRing: "pilot", version: "1.1.0" }, { ...rollout, percentage: bucket })).toMatchObject({
      eligible: false,
      reason: "outside-percentage",
    });
    expect(decideUpdateEligibility({ id, updateRing: "pilot", version: "1.1.0" }, { ...rollout, percentage: bucket + 1 })).toMatchObject({
      eligible: true,
    });
  });

  it("summarizes operational update health without exposing device details", () => {
    expect(summarizeUpdateFleetHealth([
      { id: "healthy", updateState: "healthy" },
      { id: "downloading", updateState: "downloading" },
      { id: "failed", updateState: "failed" },
      { id: "rollback", updateState: "rollback" },
      { id: "idle", updateState: "idle" },
    ])).toEqual({
      total: 5,
      healthy: 1,
      inProgress: 1,
      failed: 1,
      rollback: 1,
      pending: 1,
    });
  });
});
