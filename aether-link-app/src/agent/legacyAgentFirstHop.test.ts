import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { buildProductionUpdateSignaturePayload, buildProductionUpdateSignaturePayloadV2 } from "../domain/updateManifest";
import { INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX } from "./agentUpdateHandoffBroker";
import { prepareLegacyAgentFirstHop } from "./legacyAgentFirstHop";

const trusted = vi.hoisted(() => ({ sign: (payload: string): string => { throw new Error(payload); } }));
vi.mock("../domain/updateTrust", async () => {
  const crypto = await import("node:crypto");
  const keys = crypto.generateKeyPairSync("ed25519");
  trusted.sign = (payload) => crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64");
  return { BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }) };
});

const roots: string[] = [];
const assetName = "WonRemote-Agent-Update.exe";
const contents = Buffer.from("exact signed update bytes");
const digest = createHash("sha256").update(contents).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

function manifest(signPayload = trusted.sign, name = assetName, version = WONREMOTE_APP_VERSION, installerArgs?: string[]) {
  const url = "https://github.com/hoguengine-stack/Wonremote/releases/download/v" + version + "/" + name;
  const metadata = { assetName: name, checksum: digest, downloadUrl: url, latestVersion: version };
  return {
    version,
    forceUpdate: false,
    agentFileUpdates: {
      x86: {
        name,
        url,
        sha256: digest,
        ...(installerArgs ? { installerArgs } : {}),
        signature: signPayload(buildProductionUpdateSignaturePayload(metadata)),
        signatureV2: signPayload(buildProductionUpdateSignaturePayloadV2({
          ...metadata, arch: "x86", forceUpdate: false, updateKind: "installer", installerArgs,
        })),
      },
    },
  };
}

async function fixture(signedManifest: unknown = manifest(), bytes = contents) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wonremote-legacy-first-hop-"));
  roots.push(root);
  const appData = path.join(root, "appdata");
  const manifestPath = path.join(root, "manifest.json");
  const update = path.join(root, "verified-input.exe");
  const host = path.join(root, "wonremote-viewer.exe");
  await mkdir(appData);
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(signedManifest)), writeFile(update, bytes), writeFile(host, "baseline"),
  ]);
  return { args: ["--legacy-agent-first-hop", manifestPath, update, host], env: { APPDATA: appData, WONREMOTE_TAURI_UPDATE_BROKER: "1" }, host };
}

describe("local Agent first hop", () => {
  it("emits only the protected V2 request for the exact signed x86 File Update", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { args, env, host } = await fixture();
    const line = await prepareLegacyAgentFirstHop(args, env);
    expect(line.startsWith(INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX)).toBe(true);
    expect(line.includes("\n")).toBe(false);
    const request = JSON.parse(Buffer.from(line.slice(INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX.length), "base64url").toString());
    expect(request.version).toBe(2);
    expect(request.installerSha256).toBe(digest);
    expect(path.dirname(request.installerPath)).toBe(path.join(env.APPDATA, "WonRemote", "updates"));
    expect(await readFile(request.installerPath)).toEqual(contents);
    expect(request.acknowledgementPath).toBe(path.join(path.dirname(host), ".update-handoff", request.requestId, "installer-started.accepted"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the signed installer arguments to the inner update without the bootstrap argument", async () => {
    const input = await fixture(manifest(trusted.sign, assetName, WONREMOTE_APP_VERSION, ["/S", "/UPDATE"]));
    const line = await prepareLegacyAgentFirstHop(input.args, input.env);
    const request = JSON.parse(Buffer.from(line.slice(INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX.length), "base64url").toString());
    const script = await readFile(request.scriptPath, "utf8");
    expect(script).toContain("$InstallerArgs = @('/S', '/UPDATE')");
    expect(script).not.toContain("/FIRSTHOP=");
  });

  it("rejects a different environment key, mismatched binary, and missing broker", async () => {
    const outside = generateKeyPairSync("ed25519");
    const untrusted = await fixture(manifest((payload) => sign(null, Buffer.from(payload), outside.privateKey).toString("base64")));
    await expect(prepareLegacyAgentFirstHop(untrusted.args, {
      ...untrusted.env, WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: outside.publicKey.export({ type: "spki", format: "pem" }).toString(),
    })).rejects.toThrow(/signature/i);
    const mismatch = await fixture(manifest(), Buffer.from("different bytes"));
    await expect(prepareLegacyAgentFirstHop(mismatch.args, mismatch.env)).rejects.toThrow(/checksum/i);
    await expect(prepareLegacyAgentFirstHop(mismatch.args, { ...mismatch.env, WONREMOTE_TAURI_UPDATE_BROKER: "0" }))
      .rejects.toThrow(/broker/i);
  });

  it("requires the exact signed File Update role, compiled version and V2 signature", async () => {
    const missingSection = manifest();
    const substitute = await fixture({ version: missingSection.version, agentWindows: missingSection.agentFileUpdates });
    await expect(prepareLegacyAgentFirstHop(substitute.args, substitute.env)).rejects.toThrow(/agentFileUpdates/i);
    const wrongRole = await fixture(manifest(trusted.sign, "WonRemote-Agent-Setup.exe"));
    await expect(prepareLegacyAgentFirstHop(wrongRole.args, wrongRole.env)).rejects.toThrow(/file update/i);
    const wrongVersion = await fixture(manifest(trusted.sign, assetName, "0.1.123"));
    await expect(prepareLegacyAgentFirstHop(wrongVersion.args, wrongVersion.env)).rejects.toThrow(/version/i);
    const noV2 = manifest();
    noV2.agentFileUpdates.x86.signatureV2 = "";
    const missingV2 = await fixture(noV2);
    await expect(prepareLegacyAgentFirstHop(missingV2.args, missingV2.env)).rejects.toThrow(/v2/i);
  });
});
