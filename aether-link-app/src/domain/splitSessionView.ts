import type { ManagedDevice } from "./types";

export type SplitPairIssue = "count" | "different-group";

export function validateSameGroupSplit(devices: readonly ManagedDevice[]): SplitPairIssue | null {
  if (devices.length !== 2 || devices[0].id === devices[1].id) {
    return "count";
  }

  const [left, right] = devices;
  if (left.storeName !== right.storeName) {
    return "different-group";
  }

  return null;
}

export function clampSplitRatio(percent: number): number {
  return Math.min(80, Math.max(20, percent));
}
