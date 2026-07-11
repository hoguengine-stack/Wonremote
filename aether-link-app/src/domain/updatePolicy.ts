import { isHigherVersion } from "./versioning";

export type UpdateCheckResult = {
  latestVersion?: string;
  reloadViewer?: boolean;
};

export const DEFAULT_VIEWER_UPDATE_INTERVAL_MS = 15 * 60_000;

export function resolveViewerUpdateIntervalMs(env: Partial<Record<string, string | undefined>>): number {
  const parsed = Number(env.VITE_WONREMOTE_UPDATE_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_VIEWER_UPDATE_INTERVAL_MS;
  }
  return Math.min(24 * 60 * 60_000, Math.max(60_000, Math.trunc(parsed)));
}

export function shouldNotifyUpdate(update: UpdateCheckResult, currentVersion: string): boolean {
  return typeof update.latestVersion === "string" && isHigherVersion(update.latestVersion, currentVersion);
}

export function shouldReloadViewerForUpdate(update: UpdateCheckResult, currentVersion: string): boolean {
  return shouldNotifyUpdate(update, currentVersion) && update.reloadViewer === true;
}
