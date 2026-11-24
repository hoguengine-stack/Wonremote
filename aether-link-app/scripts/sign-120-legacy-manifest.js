import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = "hoguengine-stack/Wonremote";
const signerRef = "refs/heads/codex/sign-wonremote-lock-tolerant-120-123";
const stockRevision = "97df90878474f6d8bbb5c00632a3af7df2ccc383";
const version = "0.1.123";
const assetName = "WonRemote-Agent-Update.exe";
const releaseBase = "https://github.com/" + repository + "/releases/download/";
const manifestName = "wonremote-update-manifest.json";
const releaseApi = "https://api.github.com/repos/" + repository + "/releases";
export const draft = {
  id: 457005248,
  assetId: 787866598,
  tag: "internal-wonremote-agent120-lock-tolerant-123-20261124",
  revision: "2e6a19267e32760dea9f3e4e230a0cd2aad147a7",
};
const canonicalHash = "d1a0f26cf44a9fdea20953beaaea2d4c67a67dc4099689eecfbe2b8ff4c080ec";
const official = {
  url: releaseBase + "v0.1.123/wonremote-update-manifest.json",
  size: 5081,
  sha256: "aaa3baf2114d7df379515ba85c7a460c2a1c1027226459de907f09fe3542f55b",
};
export const bridge = {
  url: releaseBase + draft.tag + "/" + assetName,
  size: 29699315,
  sha256: "200cc1b368d624cb60bcf953408dbb978ff1f1c357beec56039e7e56ae68f496",
};
const cdnHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

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

export async function downloadPinned(pin, fetchRequest = fetch, authorizedResponse) {
  const get = url => fetchRequest(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(60_000) });
  let response = authorizedResponse ?? await get(pin.url);
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

function assertManifestAsset(asset, bytes) {
  ok(asset && asset.name === manifestName && asset.state === "uploaded"
    && Number.isSafeInteger(asset.id) && asset.id > 0 && asset.id !== draft.assetId
    && asset.size === bytes.length && asset.digest === "sha256:" + sha256(bytes),
  "Manifest upload disagrees with the verified bytes.");
}

export function assertDraft(release, uploaded, manifest) {
  ok(release?.id === draft.id && release.tag_name === draft.tag && release.target_commitish === draft.revision
    && release.draft === true && release.prerelease === true && release.published_at === null,
  "Release is not the exact approved unpublished draft.");
  ok(Array.isArray(release.assets) && release.assets.length === (uploaded ? 2 : 1),
    "Unexpected draft asset inventory.");
  const asset = release.assets.find(item => item.id === draft.assetId);
  ok(asset?.name === assetName && asset.state === "uploaded" && asset.size === bridge.size
    && asset.digest === "sha256:" + bridge.sha256, "Draft executable disagrees with the approved asset.");
  if (uploaded) {
    assertManifestAsset(release.assets.find(item => item.id === uploaded.id), manifest);
  }
}

async function signUnpublishedDraft(context = process.env) {
  assertOwner(context);
  ok(context.GH_TOKEN && typeof context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY === "string"
    && context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY.includes("-----BEGIN PRIVATE KEY-----"), "Missing trusted signing inputs.");
  const authorized = (url, accept, upload) => fetch(url, {
    method: upload ? "POST" : "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      accept,
      authorization: "Bearer " + context.GH_TOKEN,
      "x-github-api-version": "2022-11-28",
      ...(upload && { "content-type": "application/octet-stream" }),
    },
    body: upload,
  });
  const readDraft = async (uploaded, manifest) => {
    const response = await authorized(releaseApi + "/" + draft.id, "application/vnd.github+json");
    equal(response.status, 200, "Could not read the exact draft.");
    assertDraft(await response.json(), uploaded, manifest);
  };
  await readDraft();
  const [loaded, baselineBytes, bridgeBytes] = await Promise.all([
    loadStockParser(),
    downloadPinned(official),
    authorized(releaseApi + "/assets/" + draft.assetId, "application/octet-stream")
      .then(response => downloadPinned(bridge, fetch, response)),
  ]);
  assertX86(bridgeBytes);
  const output = mergeLegacyManifest(loaded.parser, JSON.parse(baselineBytes), loaded.publicKey,
    context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY, loaded.publicKey);
  const manifest = Buffer.from(JSON.stringify(output, null, 2) + "\n");
  await readDraft();
  const uploadUrl = "https://uploads.github.com/repos/" + repository + "/releases/" + draft.id
    + "/assets?name=" + manifestName;
  const response = await authorized(uploadUrl, "application/vnd.github+json", manifest);
  equal(response.status, 201, "Could not write the manifest to the unpublished draft.");
  const uploaded = await response.json();
  assertManifestAsset(uploaded, manifest);
  await readDraft(uploaded, manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    equal(process.argv.length, 2, "The branch signer accepts no command-line arguments.");
    await signUnpublishedDraft();
    console.log("Verified stock 120 operating signatures and read back the unpublished draft manifest.");
  } catch (error) {
    console.error(error.code === "ERR_ASSERTION" ? error.message.split("\n")[0] : "Signing stopped. Inspect the unpublished draft.");
    process.exitCode = 1;
  }
}
