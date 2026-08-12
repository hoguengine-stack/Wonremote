import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { isHigherVersion } from "../domain/versioning";
import { loadProductionInstallerUpdateMetadata } from "./productionUpdateMetadata";

export type ProductionUpdateCheck = {
  available: boolean;
  latestVersion: string;
};

export async function checkProductionUpdate(
  currentVersion: string = WONREMOTE_APP_VERSION,
  loadMetadata: typeof loadProductionInstallerUpdateMetadata = loadProductionInstallerUpdateMetadata,
): Promise<ProductionUpdateCheck> {
  const metadata = await loadMetadata(process.env);
  if (!metadata) {
    throw new Error("Production update metadata is unavailable.");
  }

  return {
    available: metadata.forceUpdate || isHigherVersion(metadata.latestVersion, currentVersion),
    latestVersion: metadata.latestVersion,
  };
}
