import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  constants, createCipheriv, createDecipheriv, createHash, createPublicKey,
  privateDecrypt, publicEncrypt, randomBytes, sign,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "hoguengine-stack/Wonremote";
const signerRef = "refs/heads/codex/sign-wonremote-120-bridge-123";
const stockRevision = "97df90878474f6d8bbb5c00632a3af7df2ccc383";
const version = "0.1.123";
const assetName = "WonRemote-Agent-Update.exe";
const releaseBase = "https://github.com/" + repository + "/releases/download/";
const canonicalHash = "d1a0f26cf44a9fdea20953beaaea2d4c67a67dc4099689eecfbe2b8ff4c080ec";
const official = {
  url: releaseBase + "v0.1.123/wonremote-update-manifest.json",
  size: 5081,
  sha256: "aaa3baf2114d7df379515ba85c7a460c2a1c1027226459de907f09fe3542f55b",
};
export const bridge = {
  url: releaseBase + "internal-wonremote-agent120-bridge123-20261123/" + assetName,
  size: 29690013,
  sha256: "d4b0e341a00bb039eba2c3a08acf8416c4aa0f721b82ca0c0f26778b05ceea2f",
};
const cdnHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const format = "wonremote-stock120-legacy-manifest-v1";
const aad = Buffer.from(format, "utf8");
const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" };

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertOwner(context) {
  ok(context.GITHUB_ACTIONS === "true" && context.GITHUB_EVENT_NAME === "workflow_dispatch"
    && context.GITHUB_REPOSITORY === repository && context.GITHUB_REPOSITORY_ID === "1136941328"
    && context.GITHUB_REF === signerRef && context.GITHUB_ACTOR === "hoguengine-stack"
    && context.GITHUB_ACTOR_ID === "246740147" && context.GITHUB_TRIGGERING_ACTOR === "hoguengine-stack",
  "Signing requires the original owner on the exact manual signing branch.");
}

export async function downloadPinned(pin, fetchRequest = fetch) {
  const get = url => fetchRequest(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(60_000) });
  let response = await get(pin.url);
  if (response.status === 302) {
    const location = response.headers.get("location");
    const cdn = location && new URL(location);
    ok(cdn && cdn.protocol === "https:" && cdnHosts.has(cdn.host) && !cdn.username && !cdn.password,
      "GitHub redirected outside its pinned release CDN.");
    response = await get(cdn);
  }
  equal(response.status, 200, "Pinned GitHub asset download failed.");
  equal(Number(response.headers.get("content-length") ?? pin.size), pin.size, "Asset length header disagrees with pin.");
  const bytes = Buffer.from(await response.arrayBuffer());
  equal(bytes.length, pin.size, "Downloaded byte count disagrees with pin.");
  equal(sha256(bytes), pin.sha256, "Downloaded bytes disagree with the approved SHA-256.");
  return bytes;
}

export function assertX86(bytes) {
  ok(bytes.length >= 70 && bytes.toString("ascii", 0, 2) === "MZ", "Invalid bridge executable.");
  const pe = bytes.readUInt32LE(60);
  ok(pe >= 64 && pe + 6 <= bytes.length && bytes.toString("binary", pe, pe + 4) === "PE\0\0"
    && bytes.readUInt16LE(pe + 4) === 0x014c, "Bridge executable must have an x86 PE header.");
}

export async function loadStockParser() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "wonremote-legacy120-parser-"));
  try {
    const [parser, trust] = await Promise.all(["updateManifest", "updateTrust"].map(async name => {
      const typeScript = execFileSync("git", ["show", "--no-textconv",
        stockRevision + ":aether-link-app/src/domain/" + name + ".ts"], { maxBuffer: 128 * 1024 });
      const file = path.join(temp, name + ".mts");
      await writeFile(file, typeScript, { flag: "wx" });
      return import(pathToFileURL(file).href);
    }));
    return { parser, publicKey: trust.BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY };
  } finally {
    const resolved = await realpath(temp);
    const base = await realpath(os.tmpdir());
    equal(path.dirname(resolved), base, "Refusing cleanup outside the temporary parser root.");
    ok(path.basename(resolved).startsWith("wonremote-legacy120-parser-"), "Unexpected temporary parser directory.");
    await rm(resolved, { recursive: true, force: true });
  }
}

function parseStockFileUpdate(parser, manifest, publicKeyPem) {
  return parser.parseProductionUpdateManifest({ ...manifest, agentWindows: manifest.agentFileUpdates }, {
    arch: "x86", assetKind: "installer", product: "agent", publicKeyPem,
  });
}

export function mergeLegacyManifest(parser, canonical, canonicalKey, signingKey, signingPublicKey) {
  const stock = parseStockFileUpdate(parser, canonical, canonicalKey);
  equal(stock.latestVersion, version);
  equal(stock.forceUpdate, false);
  equal(stock.assetName, assetName);
  equal(stock.checksum, canonicalHash);
  equal(stock.downloadUrl, releaseBase + "v0.1.123/" + assetName);
  const target = {
    arch: "x86", assetName, checksum: bridge.sha256, downloadUrl: bridge.url,
    forceUpdate: false, latestVersion: version, updateKind: "installer",
  };
  const signature = sign(null, Buffer.from(parser.buildProductionUpdateSignaturePayload(target)), signingKey).toString("base64");
  const signatureV2 = sign(null, Buffer.from(parser.buildProductionUpdateSignaturePayloadV2(target)), signingKey).toString("base64");
  const combined = {
    ...canonical,
    agentFileUpdates: {
      ...canonical.agentFileUpdates,
      x86: { name: assetName, sha256: bridge.sha256, url: bridge.url, signature, signatureV2 },
    },
  };
  deepStrictEqual(parseStockFileUpdate(parser, combined, signingPublicKey), {
    assetName, checksum: bridge.sha256, downloadUrl: bridge.url, forceUpdate: false,
    latestVersion: version, reloadViewer: false, signature, signatureV2, updateKind: "installer",
  });
  return combined;
}

export function sealManifest(bytes, recipient) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    format,
    recipient: sha256(createPublicKey(recipient).export({ type: "spki", format: "der" })),
    key: publicEncrypt({ key: recipient, ...oaep }, key).toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function unsealManifest(envelope, recipient) {
  equal(envelope.format, format, "Unexpected sealed manifest format.");
  equal(envelope.recipient, sha256(createPublicKey(recipient).export({ type: "spki", format: "der" })), "Wrong manifest recipient.");
  const decode = key => Buffer.from(envelope[key], "base64");
  const key = privateDecrypt({ key: recipient, ...oaep }, decode("key"));
  const decipher = createDecipheriv("aes-256-gcm", key, decode("nonce"), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(decode("tag"));
  return Buffer.concat([decipher.update(decode("ciphertext")), decipher.final()]);
}

async function signPrivateArtifact(context = process.env) {
  assertOwner(context);
  ok(typeof context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY === "string"
    && context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY.includes("-----BEGIN PRIVATE KEY-----")
    && context.RUNNER_TEMP && path.isAbsolute(context.RUNNER_TEMP), "Missing trusted signing inputs.");
  const [loaded, baselineBytes, bridgeBytes, recipient] = await Promise.all([
    loadStockParser(), downloadPinned(official), downloadPinned(bridge),
    readFile(fileURLToPath(new URL("../../.github/workflows/legacy-120-recipient.pub.pem", import.meta.url)), "utf8"),
  ]);
  assertX86(bridgeBytes);
  const output = mergeLegacyManifest(loaded.parser, JSON.parse(baselineBytes), loaded.publicKey,
    context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY, loaded.publicKey);
  const sealed = sealManifest(Buffer.from(JSON.stringify(output, null, 2) + "\n"), recipient);
  const directory = path.join(context.RUNNER_TEMP, "wonremote-legacy120-artifact");
  await mkdir(directory);
  await writeFile(path.join(directory, "stock-120-legacy-manifest.sealed.json"),
    JSON.stringify(sealed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    equal(process.argv.length, 2, "The branch signer accepts no command-line arguments.");
    await signPrivateArtifact();
    console.log("Verified stock 120 operating signatures and sealed the private artifact.");
  } catch {
    console.error("Signing stopped. No plaintext manifest was published.");
    process.exitCode = 1;
  }
}
