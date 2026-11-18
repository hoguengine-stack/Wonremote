import { handleUpdateOnceCli } from "./agentUpdateOnce";
import { handleUpdateCheckCli } from "./updateCheckCli";

process.env.WONREMOTE_UPDATE_PRODUCT = "agent";
const argv = process.argv.slice(2);
if (argv.includes("--check-update")) {
  process.exitCode = await handleUpdateCheckCli();
} else if (argv.includes("--update-once")) {
  process.exitCode = await handleUpdateOnceCli(argv, process.env, "agent");
} else {
  console.error("[WonRemote Updater] Agent updater requires an update command.");
  process.exitCode = 2;
}
