import {
  parseProductionUpdateManifest,
  type ProductionUpdateMetadata,
  type ProductionUpdateKind,
} from "../domain/updateManifest";
import { resolveProductionUpdatePublicKey } from "../domain/updateTrust";

export const DEFAULT_PRODUCTION_UPDATE_MANIFEST_URL =
  "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/wonremote-update-manifest.json";

export async function loadProductionInstallerUpdateMetadata(
  env: Partial<Record<
    | "WONREMOTE_BUILD_ARCH"
    | "WONREMOTE_PACKAGE_KIND"
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
    publicKeyPem: resolveProductionUpdatePublicKey(env),
  });
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
