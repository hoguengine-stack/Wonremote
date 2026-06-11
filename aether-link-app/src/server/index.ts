import { createApiServer } from "./apiServer";
import { createFileDeviceStore } from "./deviceStore";
import { createFileHistoryStore } from "./historyStore";
import path from "node:path";
import process from "node:process";

const port = Number(process.env.AETHER_LINK_API_PORT ?? 8787);
const host = process.env.AETHER_LINK_API_HOST ?? "127.0.0.1";
const storePath =
  process.env.AETHER_LINK_API_STORE ??
  path.join(process.env.APPDATA ?? process.cwd(), "AetherLink", "devices.json");
const historyPath =
  process.env.AETHER_LINK_HISTORY_STORE ??
  path.join(process.env.APPDATA ?? process.cwd(), "AetherLink", "connection_history.json");
const offlineAfterMs = Number(process.env.AETHER_LINK_AGENT_OFFLINE_MS ?? 30_000);

const server = createApiServer({
  deviceStore: createFileDeviceStore(storePath),
  historyStore: createFileHistoryStore(historyPath),
  offlineAfterMs,
});

server.listen(port, host, () => {
  console.log(`AetherLink API listening on http://${host}:${port}`);
  console.log(`AetherLink device store: ${storePath}`);
  console.log(`AetherLink connection history store: ${historyPath}`);
  console.log(`AetherLink agent offline threshold: ${offlineAfterMs}ms`);
});

