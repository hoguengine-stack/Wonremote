import {
  parseProductionUpdateManifest,
  type ProductionUpdateMetadata,
  type ProductionUpdateKind,
} from "../domain/updateManifest";
import { resolveProductionUpdatePublicKey, VIEWER_UPDATE_MANIFEST_URL } from "../domain/updateTrust";
import { isHigherVersion, nextPatchVersion } from "../domain/versioning";
import { decideUpdateEligibility, type UpdateFleetRollout } from "../domain/updateFleetPolicy";

export const DEFAULT_PRODUCTION_UPDATE_MANIFEST_URL =
  "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/wonremote-update-manifest.json";

const STABLE_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export async function loadProductionAgentUpdateCandidate(
  deviceId: string,
  currentVersion: string,
  rollout: UpdateFleetRollout | null,
  env: Parameters<typeof loadProductionInstallerUpdateMetadata>[0] = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ metadata: ProductionUpdateMetadata | null; selected: boolean }> {
  const version = rollout?.targetVersion;
  if (rollout?.targetDeviceIds === undefined || !version || !STABLE_VERSION.test(version)
      || !isHigherVersion(version, currentVersion) || resolveRuntimeUpdateKind(env) !== "installer"
      || resolveRuntimeUpdateProduct(env) !== "agent"
      || !decideUpdateEligibility({ id: deviceId, version: currentVersion, selectedRolloutVersion: currentVersion }, rollout).eligible) {
    return { metadata: await loadProductionInstallerUpdateMetadata(env, fetchImpl), selected: false };
  }

  return { metadata: await loadVersionPinnedAgentUpdate(version, env, fetchImpl), selected: true };
}

export async function loadViewerRequestedAgentUpdate(
  currentVersion: string,
  env: Parameters<typeof loadProductionInstallerUpdateMetadata>[0] = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductionUpdateMetadata> {
  if (!STABLE_VERSION.test(currentVersion) || resolveRuntimeUpdateKind(env) !== "installer"
      || resolveRuntimeUpdateProduct(env) !== "agent") {
    throw new Error("Viewer 업데이트 요청에는 정식 Windows Agent 설치가 필요합니다.");
  }
  return loadVersionPinnedAgentUpdate(nextPatchVersion(currentVersion), env, fetchImpl);
}

async function loadVersionPinnedAgentUpdate(
  version: string,
  env: NonNullable<Parameters<typeof loadProductionInstallerUpdateMetadata>[0]>,
  fetchImpl: typeof fetch,
): Promise<ProductionUpdateMetadata> {
  const base = `https://github.com/hoguengine-stack/Wonremote/releases/download/v${version}/`;
  const metadata = await loadProductionInstallerUpdateMetadata({
    ...env, WONREMOTE_UPDATE_MANIFEST_URL: `${base}wonremote-update-manifest.json`,
  }, fetchImpl);
  const name = env.WONREMOTE_AGENT_FILE_UPDATE === "1" ? "WonRemote-Agent-Update.exe" : "WonRemote-Agent-Setup.exe";
  if (!metadata || metadata.latestVersion !== version || metadata.forceUpdate
      || metadata.assetName !== name || metadata.downloadUrl !== `${base}${name}`) {
    throw new Error(`v${version}: signed version-pinned Agent installer is unavailable or invalid.`);
  }
  return metadata;
}

export async function loadProductionRollbackMetadata(
  requestedVersion: string,
  currentVersion: string,
  env: Parameters<typeof loadProductionInstallerUpdateMetadata>[0] = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductionUpdateMetadata> {
  if (!STABLE_VERSION.test(requestedVersion) || !STABLE_VERSION.test(currentVersion)
      || !isHigherVersion(currentVersion, requestedVersion)) throw new Error("Select an older stable version to restore.");
  if (resolveRuntimeUpdateKind(env) !== "installer") throw new Error("Rollback requires an installed product.");
  const releaseBase = `https://github.com/hoguengine-stack/Wonremote/releases/download/v${requestedVersion}/`;
  const metadata = await loadProductionInstallerUpdateMetadata({
    ...env, WONREMOTE_UPDATE_MANIFEST_URL: `${releaseBase}wonremote-update-manifest.json`,
  }, fetchImpl, true);
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
    | "WONREMOTE_AGENT_FILE_UPDATE"
    | "WONREMOTE_UPDATE_MANIFEST_URL",
    string
  >> = process.env,
  fetchImpl: typeof fetch = fetch,
  agentInstallerForRollback = false,
): Promise<ProductionUpdateMetadata | null> {
  const manifestUrl = env.WONREMOTE_UPDATE_MANIFEST_URL?.trim() || (resolveRuntimeUpdateProduct(env) === "viewer" ? VIEWER_UPDATE_MANIFEST_URL : DEFAULT_PRODUCTION_UPDATE_MANIFEST_URL);
  const separator = manifestUrl.includes("?") ? "&" : "?";
  const response = await fetchImpl(`${manifestUrl}${separator}nocache=${Date.now()}`, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    return null;
  }

  const manifest = await response.json();
  // New releases sign first-install/rollback Setup separately from file updates.
  // Historical releases without that section retain their original signed path.
  const section = agentInstallerForRollback ? "agentInstallers"
    : env.WONREMOTE_AGENT_FILE_UPDATE === "1" && resolveRuntimeUpdateKind(env) === "installer" ? "agentFileUpdates" : "agentWindows";
  const selected = resolveRuntimeUpdateProduct(env) === "agent"
    && manifest && typeof manifest === "object" && Object.prototype.hasOwnProperty.call(manifest, section)
    ? { ...manifest, agentWindows: manifest[section] }
    : manifest;
  return parseProductionUpdateManifest(selected, {
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
