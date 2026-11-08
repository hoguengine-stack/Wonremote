import { handleUpdateOnceCli } from "./agentUpdateOnce";
import { handleUpdateCheckCli } from "./updateCheckCli";

process.env.WONREMOTE_UPDATE_PRODUCT = "viewer";
const argv = process.argv.slice(2);
if (argv.includes("--check-update")) {
  process.exitCode = await handleUpdateCheckCli();
} else if (argv.includes("--update-once")) {
  process.exitCode = await handleUpdateOnceCli(argv, process.env, "viewer");
} else {
  console.error("[WonRemote Updater] Viewer updater requires an update command.");
  process.exitCode = 2;
}
