import {
  parseProductionUpdateManifest,
  type ProductionUpdateMetadata,
  type ProductionUpdateKind,
} from "../domain/updateManifest";
import { resolveProductionUpdatePublicKey } from "../domain/updateTrust";
import { isHigherVersion } from "../domain/versioning";

export const DEFAULT_PRODUCTION_UPDATE_MANIFEST_URL =
  "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/wonremote-update-manifest.json";

export async function loadProductionRollbackMetadata(
  requestedVersion: string,
  currentVersion: string,
  env: Parameters<typeof loadProductionInstallerUpdateMetadata>[0] = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductionUpdateMetadata> {
  const stableVersion = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
  if (!stableVersion.test(requestedVersion) || !stableVersion.test(currentVersion)
      || !isHigherVersion(currentVersion, requestedVersion)) throw new Error("Select an older stable version to restore.");
  if (resolveRuntimeUpdateKind(env) !== "installer") throw new Error("Rollback requires an installed product.");
  const releaseBase = `https://github.com/hoguengine-stack/Wonremote/releases/download/v${requestedVersion}/`;
  const metadata = await loadProductionInstallerUpdateMetadata({
    ...env, WONREMOTE_UPDATE_MANIFEST_URL: `${releaseBase}wonremote-update-manifest.json`,
  }, fetchImpl);
  if (!metadata || metadata.latestVersion !== requestedVersion) throw new Error("Rollback release version did not match.");
  const name = resolveRuntimeUpdateProduct(env) === "viewer" ? "WonRemote-Viewer-Setup.exe" : "WonRemote-Agent-Setup.exe";
  // Never replace a signed URL with an inferred historical URL or use mutable latest assets.
  if (metadata.assetName !== name || metadata.downloadUrl !== `${releaseBase}${name}`) {
    throw new Error("Rollback requires a signed version-pinned installer for this product.");
  }
  return metadata;
}

export async function loadProductionInstallerUpdateMetadata(
  env: Partial<Record<
    | "WONREMOTE_BUILD_ARCH"
    | "WONREMOTE_PACKAGE_KIND"
    | "WONREMOTE_UPDATE_PRODUCT"
    | "WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY"
    | "WONREMOTE_UPDATE_MANIFEST_URL",
    string
  >> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductionUpdateMetadata | null> {
  const manifestUrl = env.WONREMOTE_UPDATE_MANIFEST_URL?.trim() || DEFAULT_PRODUCTION_UPDATE_MANIFEST_URL;
  const separator = manifestUrl.includes("?") ? "&" : "?";
  const response = await fetchImpl(`${manifestUrl}${separator}nocache=${Date.now()}`);

  if (!response.ok) {
    return null;
  }

  return parseProductionUpdateManifest(await response.json(), {
    arch: resolveRuntimeArch(env),
    assetKind: resolveRuntimeUpdateKind(env),
    product: resolveRuntimeUpdateProduct(env),
    publicKeyPem: resolveProductionUpdatePublicKey(env),
  });
}

export function resolveRuntimeUpdateProduct(
  env: Partial<Record<"WONREMOTE_UPDATE_PRODUCT", string>> = process.env,
): "agent" | "viewer" {
  return env.WONREMOTE_UPDATE_PRODUCT?.trim().toLowerCase() === "viewer" ? "viewer" : "agent";
}

export function resolveRuntimeUpdateKind(
  env: Partial<Record<"WONREMOTE_PACKAGE_KIND", string>> = process.env,
): ProductionUpdateKind {
  const configured = env.WONREMOTE_PACKAGE_KIND?.trim().toLowerCase();
  if (configured === "portable" || configured === "portable-agent") {
    return configured;
  }
  return "installer";
}

function resolveRuntimeArch(
  env: Partial<Record<"WONREMOTE_BUILD_ARCH", string>> = process.env,
): "x64" | "x86" {
  const configuredArch = env.WONREMOTE_BUILD_ARCH?.trim().toLowerCase();
  if (configuredArch === "ia32" || configuredArch === "x86") {
    return "x86";
  }
  return process.arch === "ia32" ? "x86" : "x64";
}
