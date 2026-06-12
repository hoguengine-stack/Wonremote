import { createApiServer } from "./apiServer";
import { createFileDeviceStore } from "./deviceStore";
import { createFileHistoryStore } from "./historyStore";
import path from "node:path";
import process from "node:process";

const port = Number(process.env.WONREMOTE_API_PORT ?? 8787);
const host = process.env.WONREMOTE_API_HOST ?? "127.0.0.1";
const storePath =
  process.env.WONREMOTE_API_STORE ??
  path.join(process.env.APPDATA ?? process.cwd(), "WonRemote", "devices.json");
const historyPath =
  process.env.WONREMOTE_HISTORY_STORE ??
  path.join(process.env.APPDATA ?? process.cwd(), "WonRemote", "connection_history.json");
const offlineAfterMs = Number(process.env.WONREMOTE_AGENT_OFFLINE_MS ?? 30_000);

const server = createApiServer({
  deviceStore: createFileDeviceStore(storePath),
  historyStore: createFileHistoryStore(historyPath),
  offlineAfterMs,
});

server.listen(port, host, () => {
  console.log(`WonRemote API listening on http://${host}:${port}`);
  console.log(`WonRemote device store: ${storePath}`);
  console.log(`WonRemote connection history store: ${historyPath}`);
  console.log(`WonRemote agent offline threshold: ${offlineAfterMs}ms`);
});

