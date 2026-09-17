import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AgentHealthIdentity {
  registeredDeviceId?: string;
  installId: string;
}

export function createAgentHealthReporter(options: {
  baseDir: string;
  version: string;
  writeReceipt?: (file: string, data: string) => Promise<void>;
}) {
  const startedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
  const receiptPath = path.join(options.baseDir, "WonRemote", "agent-online.json");
  const writeReceipt = options.writeReceipt ?? (async (file, data) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, data, "utf8");
    await rename(temporary, file);
    await writeFile(path.join(path.dirname(file), ".update_success"), "SUCCESS", "utf8");
  });
  let attempts = 0;
  let reported = false;
  let pending: Promise<void> | undefined;
  // Readiness is availability evidence, never authorization to execute an update.
  return (config: AgentHealthIdentity, acceptedDeviceId: string): Promise<void> => {
    if (reported || attempts >= 3 || !config.registeredDeviceId || acceptedDeviceId !== config.registeredDeviceId) {
      return Promise.resolve();
    }
    if (pending) return pending;
    attempts++;
    pending = Promise.resolve().then(() => writeReceipt(receiptPath, JSON.stringify({
      schemaVersion: 1,
      version: options.version,
      deviceId: acceptedDeviceId,
      installId: config.installId,
      pid: process.pid,
      executablePath: process.execPath,
      startedAt,
      acceptedAt: new Date().toISOString(),
    }))).then(() => { reported = true; }).finally(() => { pending = undefined; });
    return pending;
  };
}
