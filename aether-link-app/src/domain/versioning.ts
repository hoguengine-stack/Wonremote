type VersionEnv = {
  readonly VITE_AETHER_LINK_APP_VERSION?: string;
};

export function getViewerVersion(env: VersionEnv): string {
  return env.VITE_AETHER_LINK_APP_VERSION?.trim() || "0.0.0";
}

export function isHigherVersion(latestVersion: string, currentVersion: string): boolean {
  const latestParts = parseVersion(latestVersion);
  const currentParts = parseVersion(currentVersion);

  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] > currentParts[index]) {
      return true;
    }
    if (latestParts[index] < currentParts[index]) {
      return false;
    }
  }

  return false;
}

function parseVersion(version: string): [number, number, number] {
  const parts = version.split(".").map((part) => Number(part));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}
