import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "hoguengine-stack/Wonremote";
const signerRef = "refs/heads/codex/sign-wonremote-120-bridge-123";
const version = "0.1.123";
const bridgeTag = "internal-wonremote-agent120-bridge123-20261123";
const assetName = "WonRemote-Agent-Update.exe";
const approvedInstallerArgs = '["/S","/UPDATE"]';
const manifestName = "wonremote-update-manifest.json";
const approvedDraft = {
  id: 455731614,
  tag: bridgeTag,
  size: 29690013,
  sha256: "d4b0e341a00bb039eba2c3a08acf8416c4aa0f721b82ca0c0f26778b05ceea2f",
};
const publicAssets = [
  { name: "WonRemote-Viewer-Setup.exe", size: 19950963, sha256: "4bd1e55d33eaa95412f56b7d82e5f1688fa627f34b6a56619ca625768de06e83" },
  { name: "WonRemote-Agent-Setup.exe", size: 29755950, sha256: "5c2de3a6d04aa5bd4d48e398470f4439848702183534f8cdd620e7f6e3f68fb2" },
];
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitHubApi = "https://api.github.com/repos/" + repository + "/releases/";
const publicBase = "https://github.com/" + repository + "/releases/download/v" + version + "/";
const bridgeUrl = "https://github.com/" + repository + "/releases/download/" + bridgeTag + "/" + assetName;
const cdnHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

class ApprovalError extends Error {}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertApproval(context, pins) {
  if (context.GITHUB_ACTIONS !== "true" || context.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || context.GITHUB_REPOSITORY !== repository || context.GITHUB_REPOSITORY_ID !== "1136941328"
    || context.GITHUB_REF !== signerRef || context.GITHUB_ACTOR !== "hoguengine-stack"
    || context.GITHUB_ACTOR_ID !== "246740147" || context.GITHUB_TRIGGERING_ACTOR !== "hoguengine-stack") {
    throw new ApprovalError("Signing requires the original owner on the exact manual signing branch.");
  }
  if (!Number.isSafeInteger(pins.id) || pins.id <= 0 || pins.tag !== bridgeTag
    || !Number.isSafeInteger(pins.size) || pins.size < 70 || !/^[a-f0-9]{64}$/.test(pins.sha256)) {
    throw new ApprovalError("Exact approved bridge draft and installer size/SHA-256 pins are required.");
  }
}

function readApprovedAssetId(release, pins, verifiedManifest) {
  if (release?.id !== pins.id || release.draft !== true || release.published_at !== null || release.tag_name !== pins.tag) {
    throw new ApprovalError("GitHub release must be the approved unpublished bridge draft.");
  }
  if (!Array.isArray(release.assets) || release.assets.length !== 1 + Number(Boolean(verifiedManifest))) {
    throw new ApprovalError("The draft asset inventory differs from the approved inventory.");
  }
  const asset = release.assets.find(item => item.name === assetName);
  if (!asset || asset.state !== "uploaded" || asset.size !== pins.size || asset.digest !== "sha256:" + pins.sha256
    || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
    throw new ApprovalError("Draft asset metadata changed or disagrees with its pin.");
  }
  if (verifiedManifest) {
    const item = release.assets.find(asset => asset.name === manifestName);
    if (!item || item.id === asset.id || item.id !== verifiedManifest.id || item.state !== "uploaded"
      || item.size !== verifiedManifest.size || item.digest !== verifiedManifest.digest) {
      throw new ApprovalError("The verified manifest was not found on the unpublished draft.");
    }
  }
  return asset.id;
}

async function downloadPinnedExecutable(request, response, pin) {
  if (response.status === 302) {
    const location = response.headers.get("location");
    const cdn = location && new URL(location);
    if (!cdn || cdn.protocol !== "https:" || !cdnHosts.has(cdn.host) || cdn.username || cdn.password) {
      throw new ApprovalError("GitHub asset redirected outside its release CDN.");
    }
    response = await request(cdn);
  }
  if (response.status !== 200 || Number(response.headers.get("content-length") ?? pin.size) !== pin.size) {
    throw new ApprovalError("Downloading the pinned installer failed.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== pin.size || sha256(bytes) !== pin.sha256 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new ApprovalError("Downloaded installer bytes disagree with the pinned x86 executable.");
  }
  const header = bytes.readUInt32LE(60);
  if (header + 6 > bytes.length || bytes.toString("binary", header, header + 4) !== "PE\0\0"
    || bytes.readUInt16LE(header + 4) !== 0x014c) {
    throw new ApprovalError("Downloaded installer does not have an x86 PE header.");
  }
  return bytes;
}

function runManifestScript(script, args, env) {
  const result = spawnSync(process.execPath, ["scripts/" + script, ...args], {
    cwd: appRoot,
    env,
    stdio: "ignore",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new ApprovalError("Manifest generation or bundled operating-key verification failed.");
  }
}

function generateAndVerifyManifest({ paths, manifestPath, context }) {
  const key = context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY;
  if (typeof key !== "string" || !key.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new ApprovalError("The operating signing key is unavailable to this workflow.");
  }
  const [viewer, agent, bridge] = paths;
  const commonArgs = ["--version", version, "--viewer-x64", viewer, "--agent-x64", agent, "--agent-update-x64", bridge];
  runManifestScript("create-update-manifest.js", [
    ...commonArgs, "--release-tag", bridgeTag, "--force-update", "false",
    "--viewer-download-url-x64", publicBase + publicAssets[0].name,
    "--viewer-download-url-x86", publicBase + publicAssets[0].name,
    "--agent-download-url-x64", publicBase + publicAssets[1].name,
    "--agent-download-url-x86", publicBase + publicAssets[1].name,
    "--agent-installer-args", approvedInstallerArgs, "--out", manifestPath,
  ], { WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY: key });
  runManifestScript("verify-release-manifest.js", [...commonArgs, "--manifest", manifestPath], {});
}

function serializeBridgeManifest(metadata, pins) {
  const asset = metadata.agentFileUpdates?.x86;
  if (metadata.version !== version || metadata.forceUpdate !== false || asset?.name !== assetName
    || asset.url !== bridgeUrl || asset.sha256 !== pins.sha256
    || JSON.stringify(asset.installerArgs) !== approvedInstallerArgs
    || ![asset.signature, asset.signatureV2].every(signature => typeof signature === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(signature))) {
    throw new ApprovalError("Manifest disagrees with the bridge version, pinned asset, or signed installer argument policy.");
  }
  return Buffer.from(JSON.stringify({ version, forceUpdate: false, agentFileUpdates: { x86: asset } }, null, 2) + "\n");
}

export async function signBridgeDraft({
  context = process.env,
  pins = approvedDraft,
  sidecars = publicAssets,
  fetchRequest = fetch,
  signAndVerify = generateAndVerifyManifest,
} = {}) {
  assertApproval(context, pins);
  if (!context.GH_TOKEN) throw new ApprovalError("An authenticated workflow token is required.");

  const request = (url, options = {}) => fetchRequest(url, {
    method: "GET", ...options, redirect: "manual", signal: AbortSignal.timeout(60_000),
  });
  const authorized = (url, options = {}, accept = "application/vnd.github+json") => request(url, {
    ...options,
    headers: { ...options.headers, accept, authorization: "Bearer " + context.GH_TOKEN, "x-github-api-version": "2022-11-28" },
  });
  const readDraft = async verifiedManifest => {
    const response = await authorized(gitHubApi + pins.id);
    if (response.status !== 200) throw new ApprovalError("Reading the approved draft metadata failed.");
    return readApprovedAssetId(await response.json(), pins, verifiedManifest);
  };

  const originalId = await readDraft();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-120-bridge-draft-sign-"));
  try {
    const bridgePath = path.join(tempDir, assetName);
    const bridgeBytes = await downloadPinnedExecutable(request, await authorized(gitHubApi + "assets/" + originalId, {}, "application/octet-stream"), pins);
    fs.writeFileSync(bridgePath, bridgeBytes, { mode: 0o600, flag: "wx" });
    const paths = [];
    for (const pin of sidecars) {
      const sidecarPath = path.join(tempDir, pin.name);
      const bytes = await downloadPinnedExecutable(request, await request(publicBase + pin.name), pin);
      fs.writeFileSync(sidecarPath, bytes, { mode: 0o600, flag: "wx" });
      paths.push(sidecarPath);
    }
    const manifestPath = path.join(tempDir, manifestName);
    signAndVerify({ paths: [...paths, bridgePath], manifestPath, context });
    const manifest = serializeBridgeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")), pins);
    if (await readDraft() !== originalId) throw new ApprovalError("The approved draft changed during signing.");

    const uploadUrl = "https://uploads.github.com/repos/" + repository + "/releases/" + pins.id + "/assets?name=" + manifestName;
    const response = await authorized(uploadUrl, { method: "POST", body: manifest, headers: { "content-type": "application/octet-stream" } });
    if (response.status !== 201) throw new ApprovalError("Writing the verified manifest to the draft failed.");
    const uploaded = await response.json();
    if (uploaded.name !== manifestName || uploaded.state !== "uploaded" || uploaded.size !== manifest.length
      || uploaded.digest !== "sha256:" + sha256(manifest) || !Number.isSafeInteger(uploaded.id) || uploaded.id <= 0) {
      throw new ApprovalError("The draft manifest upload response disagrees with the verified bytes.");
    }
    if (await readDraft(uploaded) !== originalId) throw new ApprovalError("The unpublished draft changed after the manifest was written.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new ApprovalError("This signing job takes no command-line arguments.");
    await signBridgeDraft();
    console.log("Operating signature verified and uploaded to the approved unpublished bridge draft.");
  } catch (error) {
    console.error(error instanceof ApprovalError ? error.message : "Bridge signing stopped; inspect the draft without retrying.");
    process.exitCode = 1;
  }
}
