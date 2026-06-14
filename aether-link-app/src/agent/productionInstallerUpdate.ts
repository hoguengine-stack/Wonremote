import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type InstallerUpdateMetadata = {
  assetName?: unknown;
  checksum?: unknown;
  downloadUrl?: unknown;
  installerArgs?: unknown;
  latestVersion?: unknown;
  updateKind?: unknown;
};

export type InstallerDownloadResult = {
  installerArgs: string[];
  installerPath: string;
};

export type SafeInstallerUpdateMetadata = InstallerUpdateMetadata & {
  checksum: string;
  downloadUrl: string;
  latestVersion: string;
  updateKind: "installer";
};

type DownloadInstallerOptions = {
  baseDir: string;
  fetchImpl?: typeof fetch;
};

export function isInstallerUpdateMetadata(value: unknown): value is SafeInstallerUpdateMetadata {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.updateKind === "installer" &&
    typeof value.latestVersion === "string" &&
    value.latestVersion.trim().length > 0 &&
    typeof value.downloadUrl === "string" &&
    isHttpsUrl(value.downloadUrl) &&
    typeof value.checksum === "string" &&
    /^[a-fA-F0-9]{64}$/.test(value.checksum)
  );
}

export async function downloadInstallerUpdate(
  metadata: InstallerUpdateMetadata,
  options: DownloadInstallerOptions,
): Promise<InstallerDownloadResult> {
  if (!isInstallerUpdateMetadata(metadata)) {
    throw new Error("Installer update metadata is incomplete or unsafe.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(metadata.downloadUrl);
  if (!response.ok) {
    throw new Error(`Installer download failed: HTTP ${response.status}`);
  }

  const installerBuffer = Buffer.from(await response.arrayBuffer());
  const actualChecksum = createHash("sha256").update(installerBuffer).digest("hex");
  const expectedChecksum = metadata.checksum.toLowerCase();
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Installer checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  }

  const updatesDir = path.join(options.baseDir, "WonRemote", "updates");
  await mkdir(updatesDir, { recursive: true });
  const installerPath = path.join(updatesDir, safeInstallerName(metadata));
  await writeFile(installerPath, installerBuffer);

  return {
    installerArgs: installerArgsForUpdate(metadata),
    installerPath,
  };
}

export function installerArgsForUpdate(metadata: Pick<InstallerUpdateMetadata, "installerArgs">): string[] {
  if (!Array.isArray(metadata.installerArgs)) {
    return ["/S"];
  }
  const args = metadata.installerArgs.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return args.length > 0 ? args : ["/S"];
}

function safeInstallerName(metadata: InstallerUpdateMetadata): string {
  const rawName = typeof metadata.assetName === "string" && metadata.assetName.trim()
    ? metadata.assetName.trim()
    : filenameFromUrl(String(metadata.downloadUrl ?? ""));
  const basename = path.basename(rawName).replace(/[<>:"|?*]/g, "_");
  return basename.toLowerCase().endsWith(".exe") ? basename : `${basename}.exe`;
}

function filenameFromUrl(downloadUrl: string): string {
  try {
    const url = new URL(downloadUrl);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "WonRemote Installer.exe");
  } catch {
    return "WonRemote Installer.exe";
  }
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
