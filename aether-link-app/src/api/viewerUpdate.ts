import type { UpdateCheckResult } from "../domain/updatePolicy";

export const DEFAULT_VIEWER_UPDATE_RELEASE_API_URL =
  "https://api.github.com/repos/hoguengine-stack/Wonremote/releases/latest";

type ManifestAsset = {
  name?: unknown;
  sha256?: unknown;
  url?: unknown;
};

export async function fetchViewerUpdateMetadata(
  env: unknown = import.meta.env,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheckResult | null> {
  const manifestUrl = readEnvString(env, "VITE_WONREMOTE_UPDATE_MANIFEST_URL") || DEFAULT_VIEWER_UPDATE_RELEASE_API_URL;
  const separator = manifestUrl.includes("?") ? "&" : "?";
  const response = await fetchImpl(`${manifestUrl}${separator}nocache=${Date.now()}`);

  if (!response.ok) {
    return null;
  }

  try {
    return parseViewerUpdateManifest(await response.json());
  } catch {
    return null;
  }
}

function parseViewerUpdateManifest(input: unknown): UpdateCheckResult | null {
  if (!isRecord(input)) {
    return null;
  }

  const latestVersion = readManifestVersion(input);
  if (!latestVersion) {
    return null;
  }

  const asset = selectWindowsX64Asset(input);
  if (!asset) {
    return null;
  }

  const downloadUrl = typeof asset.url === "string" ? asset.url.trim() : "";
  const checksum = typeof asset.sha256 === "string" ? asset.sha256.trim().toLowerCase() : "";
  if (!isHttpsUrl(downloadUrl) || !/^[a-f0-9]{64}$/.test(checksum)) {
    return null;
  }

  return {
    latestVersion,
    reloadViewer: Boolean(input.reloadViewer),
  };
}

function selectWindowsX64Asset(input: Record<string, unknown>): ManifestAsset | null {
  if (Array.isArray(input.assets)) {
    const installerAsset = input.assets.find((asset): asset is Record<string, unknown> => {
      if (!isRecord(asset)) {
        return false;
      }
      const name = typeof asset.name === "string" ? asset.name : "";
      return /\.exe$/i.test(name);
    });
    if (installerAsset) {
      return {
        name: installerAsset.name,
        sha256: readGitHubAssetDigest(installerAsset.digest),
        url: installerAsset.browser_download_url,
      };
    }
  }

  const windows = input.windows;
  if (isRecord(windows) && isRecord(windows.x64)) {
    return windows.x64 as ManifestAsset;
  }
  if (isRecord(input.installer)) {
    return input.installer as ManifestAsset;
  }
  return null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readManifestVersion(input: Record<string, unknown>): string {
  if (typeof input.version === "string" && input.version.trim()) {
    return input.version.trim();
  }
  if (typeof input.tag_name === "string" && input.tag_name.trim()) {
    return input.tag_name.trim().replace(/^v/i, "");
  }
  return "";
}

function readGitHubAssetDigest(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

function readEnvString(env: unknown, key: string): string | undefined {
  if (!isRecord(env)) {
    return undefined;
  }
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
