import { verify } from "node:crypto";

export type ProductionUpdateMetadata = {
  assetName: string;
  checksum: string;
  downloadUrl: string;
  forceUpdate: boolean;
  latestVersion: string;
  reloadViewer: boolean;
  signature?: string;
  updateKind: "installer";
};

export type ProductionUpdateManifestOptions = {
  arch?: "x64" | "x86";
  publicKeyPem?: string;
};

type ManifestAsset = {
  name?: unknown;
  sha256?: unknown;
  signature?: unknown;
  url?: unknown;
};

export function parseProductionUpdateManifest(
  input: unknown,
  options: ProductionUpdateManifestOptions = {},
): ProductionUpdateMetadata {
  if (!isRecord(input)) {
    throw new Error("Production update manifest must be a JSON object.");
  }

  const latestVersion = readRequiredString(input.version, "version");
  const arch = options.arch ?? "x64";
  const asset = selectWindowsAsset(input, arch);
  const downloadUrl = readRequiredString(asset.url, `windows.${arch}.url`);
  const checksum = readRequiredString(asset.sha256, `windows.${arch}.sha256`).toLowerCase();

  if (!isHttpsUrl(downloadUrl)) {
    throw new Error("Production update manifest must include a valid HTTPS installer URL.");
  }
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error("Production update manifest must include a 64-character SHA-256 checksum.");
  }

  const assetName = typeof asset.name === "string" && asset.name.trim()
    ? asset.name.trim()
    : deriveAssetName(downloadUrl);
  const signature = typeof asset.signature === "string" && asset.signature.trim()
    ? asset.signature.trim()
    : undefined;

  const metadata: ProductionUpdateMetadata = {
    assetName,
    checksum,
    downloadUrl,
    forceUpdate: Boolean(input.forceUpdate),
    latestVersion,
    reloadViewer: false,
    signature,
    updateKind: "installer",
  };

  if (options.publicKeyPem) {
    verifyProductionUpdateSignature(metadata, options.publicKeyPem);
  }

  return metadata;
}

export function buildProductionUpdateSignaturePayload(input: {
  assetName: string;
  checksum: string;
  downloadUrl: string;
  latestVersion: string;
}): string {
  return [
    `version=${input.latestVersion}`,
    `url=${input.downloadUrl}`,
    `sha256=${input.checksum.toLowerCase()}`,
    `assetName=${input.assetName}`,
  ].join("\n");
}

function verifyProductionUpdateSignature(metadata: ProductionUpdateMetadata, publicKeyPem: string): void {
  if (!metadata.signature) {
    throw new Error("Production update manifest signature is required when a public key is configured.");
  }
  const payload = buildProductionUpdateSignaturePayload(metadata);
  const ok = verify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(metadata.signature, "base64"));
  if (!ok) {
    throw new Error("Production update manifest signature verification failed.");
  }
}

function selectWindowsAsset(input: Record<string, unknown>, arch: "x64" | "x86"): ManifestAsset {
  const windows = input.windows;
  if (isRecord(windows) && isRecord(windows[arch])) {
    return windows[arch] as ManifestAsset;
  }
  if (arch === "x64" && isRecord(input.installer)) {
    return input.installer as ManifestAsset;
  }
  throw new Error(`Production update manifest must include windows.${arch} installer metadata.`);
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Production update manifest field ${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function deriveAssetName(downloadUrl: string): string {
  try {
    const pathname = new URL(downloadUrl).pathname;
    const basename = pathname.split("/").filter(Boolean).pop();
    return basename ? decodeURIComponent(basename) : "WonRemote Installer.exe";
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
