import { describe, expect, it } from "vitest";
import {
  decideUpdateEligibility,
  hashDeviceIdToPercentageBucket,
  parseRolloutSelection,
} from "./updateFleetPolicy";

describe("update fleet policy", () => {
  it("fails closed when rollout policy is unavailable", () => {
    expect(decideUpdateEligibility({ id: "field-agent", version: "1.0.0" }, null)).toMatchObject({
      eligible: false,
      reason: "missing-rollout-policy",
    });
    expect(decideUpdateEligibility({ id: "field-agent", version: "1.0.0" }, undefined)).toMatchObject({
      eligible: false,
      reason: "missing-rollout-policy",
    });
  });

  it("targets exact IDs while the legacy projection excludes every PC", () => {
    const policy = {targetVersion:"2.0.0",stage:"general" as const,percentage:0,targetDeviceIds:["selected"]};
    expect(decideUpdateEligibility({id:"selected",version:"1.0.0",selectedRolloutVersion:"1.0.0"},policy).eligible).toBe(true);
    expect(decideUpdateEligibility({id:"selected",version:"1.0.0"},policy).reason).toBe("selection-support-unknown");
    expect(decideUpdateEligibility({id:"selected",version:"1.0.0",selectedRolloutVersion:"1.1.0"},policy).reason).toBe("selection-support-unknown");
    expect(decideUpdateEligibility({id:"other",version:"1.0.0"},policy).reason).toBe("not-selected");
    expect(decideUpdateEligibility({id:"selected",updatePaused:true},policy).reason).toBe("paused");
    expect(decideUpdateEligibility({id:"selected"},{...policy,percentage:100}).reason).toBe("invalid-selection-policy");
    const {targetDeviceIds, ...legacy} = policy;
    for (const id of ["selected","other", ...Array.from({length:100},(_,i)=>`pc-${i}`)]) {
      expect(decideUpdateEligibility({id},legacy).eligible).toBe(false);
    }
  });
  it("keeps invalid or empty selections closed and null as fleet mode", () => {
    expect(parseRolloutSelection(null)).toEqual({});
    expect(parseRolloutSelection(["one","one"])).toEqual({targetDeviceIds:["one"]});
    for (const input of ["one",{},[1],[""],Array(201).fill("one"),[]]) {
      const selection=parseRolloutSelection(input);
      expect(selection).toEqual({targetDeviceIds:[]});
      expect(decideUpdateEligibility({id:"one"},{targetVersion:"2",stage:"general",percentage:0,...selection}).eligible).toBe(false);
    }
  });
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
});
