import {
  parseProductionUpdateManifest,
  type ProductionUpdateMetadata,
} from "../domain/updateManifest";
import { resolveProductionUpdatePublicKey } from "../domain/updateTrust";

export const DEFAULT_PRODUCTION_UPDATE_MANIFEST_URL =
  "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/wonremote-update-manifest.json";

export async function loadProductionInstallerUpdateMetadata(
  env: Partial<Record<"WONREMOTE_BUILD_ARCH" | "WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY" | "WONREMOTE_UPDATE_MANIFEST_URL", string>> = process.env,
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
    publicKeyPem: resolveProductionUpdatePublicKey(env),
  });
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
