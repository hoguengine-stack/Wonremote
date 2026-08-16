import { verify } from "node:crypto";

export type ProductionUpdateMetadata = {
  assetName: string;
  checksum: string;
  downloadUrl: string;
  forceUpdate: boolean;
  latestVersion: string;
  reloadViewer: boolean;
  signature?: string;
  signatureV2?: string;
  updateKind: ProductionUpdateKind;
};

export type ProductionUpdateKind = "installer" | "portable" | "portable-agent";

export type ProductionUpdateManifestOptions = {
  arch?: "x64" | "x86";
  assetKind?: ProductionUpdateKind;
  product?: "agent" | "viewer";
  publicKeyPem?: string;
};

type ManifestAsset = {
  name?: unknown;
  sha256?: unknown;
  signature?: unknown;
  signatureV2?: unknown;
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
  const assetKind = options.assetKind ?? "installer";
  const product = options.product ?? "agent";
  const manifestSection = manifestSectionForKind(assetKind, product);
  const asset = selectReleaseAsset(input, arch, assetKind, product);
  const downloadUrl = readRequiredString(asset.url, `${manifestSection}.${arch}.url`);
  const checksum = readRequiredString(asset.sha256, `${manifestSection}.${arch}.sha256`).toLowerCase();

  if (!isHttpsUrl(downloadUrl)) {
    throw new Error(`Production update manifest must include a valid HTTPS ${assetKind} URL.`);
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
  const signatureV2 = typeof asset.signatureV2 === "string" && asset.signatureV2.trim()
    ? asset.signatureV2.trim()
    : undefined;

  const metadata: ProductionUpdateMetadata = {
    assetName,
    checksum,
    downloadUrl,
    forceUpdate: Boolean(input.forceUpdate),
    latestVersion,
    reloadViewer: false,
    signature,
    signatureV2,
    updateKind: assetKind,
  };

  if (options.publicKeyPem) {
    verifyProductionUpdateSignature(metadata, options.publicKeyPem, arch);
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

export function buildProductionUpdateSignaturePayloadV2(input: {
  arch: "x64" | "x86";
  assetName: string;
  checksum: string;
  downloadUrl: string;
  forceUpdate: boolean;
  latestVersion: string;
  updateKind: ProductionUpdateKind;
}): string {
  return [
    "signatureVersion=2",
    `version=${input.latestVersion}`,
    `url=${input.downloadUrl}`,
    `sha256=${input.checksum.toLowerCase()}`,
    `assetName=${input.assetName}`,
    `forceUpdate=${input.forceUpdate ? "true" : "false"}`,
    `updateKind=${input.updateKind}`,
    `arch=${input.arch}`,
  ].join("\n");
}

function verifyProductionUpdateSignature(
  metadata: ProductionUpdateMetadata,
  publicKeyPem: string,
  arch: "x64" | "x86",
): void {
  if (!metadata.signature) {
    throw new Error("Production update manifest signature is required when a public key is configured.");
  }
  const payload = buildProductionUpdateSignaturePayload(metadata);
  const ok = verify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(metadata.signature, "base64"));
  if (!ok) {
    throw new Error("Production update manifest signature verification failed.");
  }
  if (!metadata.signatureV2) {
    throw new Error("Production update manifest v2 signature is required when a public key is configured.");
  }
  const payloadV2 = buildProductionUpdateSignaturePayloadV2({ ...metadata, arch });
  const okV2 = verify(null, Buffer.from(payloadV2, "utf8"), publicKeyPem, Buffer.from(metadata.signatureV2, "base64"));
  if (!okV2) {
    throw new Error("Production update manifest v2 signature verification failed.");
  }
}

function selectReleaseAsset(
  input: Record<string, unknown>,
  arch: "x64" | "x86",
  assetKind: ProductionUpdateKind,
  product: "agent" | "viewer",
): ManifestAsset {
  const sectionName = manifestSectionForKind(assetKind, product);
  const section = input[sectionName];
  if (isRecord(section) && isRecord(section[arch])) {
    return section[arch] as ManifestAsset;
  }
  if (assetKind === "installer" && isRecord(input.windows) && isRecord(input.windows[arch])) {
    return input.windows[arch] as ManifestAsset;
  }
  if (assetKind === "installer" && arch === "x64" && isRecord(input.installer)) {
    return input.installer as ManifestAsset;
  }
  throw new Error(`Production update manifest must include ${sectionName}.${arch} ${assetKind} metadata.`);
}

function manifestSectionForKind(
  assetKind: ProductionUpdateKind,
  product: "agent" | "viewer",
): "agentWindows" | "viewerWindows" | "portable" | "portableAgent" {
  if (assetKind === "portable") {
    return "portable";
  }
  if (assetKind === "portable-agent") {
    return "portableAgent";
  }
  return product === "viewer" ? "viewerWindows" : "agentWindows";
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
