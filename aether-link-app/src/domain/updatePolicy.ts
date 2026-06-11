import { isHigherVersion } from "./versioning";

export type UpdateCheckResult = {
  latestVersion?: string;
  reloadViewer?: boolean;
};

export function shouldNotifyUpdate(update: UpdateCheckResult, currentVersion: string): boolean {
  return typeof update.latestVersion === "string" && isHigherVersion(update.latestVersion, currentVersion);
}

export function shouldReloadViewerForUpdate(update: UpdateCheckResult, currentVersion: string): boolean {
  return shouldNotifyUpdate(update, currentVersion) && update.reloadViewer === true;
}
