import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import asset from "./tossEmergencyOrdersAsset.json";

let pending: Promise<string> | null = null;

export function downloadTossEmergencyOrders(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (pending) return pending;
  pending = download(env).finally(() => { pending = null; });
  return pending;
}

async function download(env: NodeJS.ProcessEnv): Promise<string> {
  if (!env.USERPROFILE || !path.isAbsolute(env.USERPROFILE)) throw Error("Remote user profile is unavailable.");
  const folder = path.join(env.USERPROFILE, "Downloads");
  const target = path.join(folder, asset.filename);
  const matches = (bytes: Buffer) => bytes.length === asset.size && createHash("sha256").update(bytes).digest("hex") === asset.sha256;
  try {
    const existing = await stat(target);
    if (existing.size === asset.size && matches(await readFile(target))) return target;
    throw Error("A different TossEmergencyOrders installer already exists in Downloads; it was not overwritten.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw Error(`TossEmergencyOrders download failed (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > asset.size) throw Error("TossEmergencyOrders download exceeds the expected size.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (!matches(bytes)) throw Error("TossEmergencyOrders download checksum does not match.");
  await mkdir(folder, { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
  return target;
}
