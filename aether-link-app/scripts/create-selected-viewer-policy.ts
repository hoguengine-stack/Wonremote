import { sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadSelectedViewerUpdate, selectedViewerPolicyPayload } from "../src/agent/selectedViewerUpdate";

export async function createSelectedViewerPolicy(input: {
  manifest: unknown;
  targets: string[];
  expiresAt: string;
  privateKey: string;
  enabled?: boolean;
}, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const targets = [...new Set(input.targets.map(id => id.trim().toUpperCase()))];
  if (!targets.length || targets.length > 100 || targets.some(id => !/^[A-F0-9]{8}$/.test(id))) {
    throw new Error("Supply explicit eight-character Viewer install IDs; no wildcard targets allowed");
  }
  const payload = { product: "viewer", enabled: true, targetInstallIds: targets, expiresAt: input.expiresAt, manifest: input.manifest };
  const signed = () => ({ payload, signature: sign(null, Buffer.from(selectedViewerPolicyPayload(payload)), input.privateKey).toString("base64") });
  // Use the installed client's verifier, including the pinned trust key and nested installer signatures.
  const validated = await loadSelectedViewerUpdate(
    { ...env, WONREMOTE_UPDATE_PRODUCT: "viewer", WONREMOTE_VIEWER_INSTALL_ID: targets[0] },
    async () => new Response(JSON.stringify(signed())), now,
  );
  if (!validated) throw new Error("Selected Viewer policy did not validate");
  payload.enabled = input.enabled !== false;
  return signed();
}

async function main() {
  const { values } = parseArgs({ options: {
    manifest: { type: "string" }, targets: { type: "string" }, expires: { type: "string" },
    output: { type: "string" }, disable: { type: "boolean", default: false },
  } });
  if (!values.manifest || !values.targets || !values.expires || !values.output) {
    throw new Error("Required: --manifest <signed-manifest.json> --targets <ID,ID> --expires <ISO-date> --output <new-file.json> [--disable]");
  }
  const source = process.env.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY;
  if (!source) throw new Error("WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY is required");
  const result = await createSelectedViewerPolicy({
    manifest: JSON.parse(readFileSync(path.resolve(values.manifest), "utf8")),
    targets: values.targets.split(","), expiresAt: values.expires,
    privateKey: source.includes("BEGIN PRIVATE KEY") ? source : readFileSync(path.resolve(source), "utf8"),
    enabled: !values.disable,
  });
  writeFileSync(path.resolve(values.output), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(`Created ${values.output} for ${result.payload.targetInstallIds.join(", ")}; enabled=${result.payload.enabled}. Not published.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Policy generation failed"); process.exitCode = 1; });
}
