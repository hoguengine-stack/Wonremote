import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { checkProductionUpdate } from "./productionUpdateCheck";
import { loadSelectedViewerUpdate } from "./selectedViewerUpdate";

export async function handleUpdateCheckCli(): Promise<number> {
  try {
    const selected = process.env.WONREMOTE_SELECTED_VIEWER_UPDATE === "1";
    const metadata = selected ? await loadSelectedViewerUpdate() : null;
    const result = selected
      ? metadata ? await checkProductionUpdate(undefined, async () => metadata) : { available: false, latestVersion: WONREMOTE_APP_VERSION }
      : await checkProductionUpdate();
    console.log(`[WonRemoteUpdateCheck]${JSON.stringify(result)}`);
    return 0;
  } catch (error) {
    console.error(`[WonRemote Updater] ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}
