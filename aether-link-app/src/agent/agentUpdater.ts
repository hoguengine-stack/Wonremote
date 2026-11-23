import { prepareLegacyAgentFirstHop } from "./legacyAgentFirstHop";

try {
  process.stdout.write(await prepareLegacyAgentFirstHop(process.argv.slice(2)) + "\n");
} catch (error) {
  console.error("[WonRemote Updater] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
