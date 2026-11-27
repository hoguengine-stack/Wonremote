import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "hoguengine-stack/Wonremote";
const signerRef = "refs/heads/codex/sign-wonremote-126-draft";
const version = "0.1.126";
const canonicalTag = "v0.1.126";
const manifestName = "wonremote-update-manifest.json";
const assetNames = [
  "WonRemote-Viewer-Setup.exe",
  "WonRemote-Agent-Setup.exe",
  "WonRemote-Agent-Update.exe",
];
const approvedDraft = {
  "id": 460209637,
  "tag": "internal-wonremote-126-0050b2987c6747ad9f23e7354b291c86",
  "assets": {
    "WonRemote-Viewer-Setup.exe": {
      "size": 20098725,
      "sha256": "1f22c4abfde5cf29393303612d2981792c14a4fe831d6180fdcd74db535c9d5f"
    },
    "WonRemote-Agent-Setup.exe": {
      "size": 29991342,
      "sha256": "3341a2408362284966aabf4248eaf469c667bbe7834d439aa18a083e5868f0ef"
    },
    "WonRemote-Agent-Update.exe": {
      "size": 29885885,
      "sha256": "bd336b46cbe5886c07d33701dde2f721ceef991e52b06e0ea60249a1f52b9c53"
    }
  }
};
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitHubApi = "https://api.github.com/repos/" + repository + "/releases/";
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

  const approvedAssets = assetNames.map(name => pins.assets?.[name]);
  if (!Number.isSafeInteger(pins.id) || pins.id <= 0
    || !/^internal-wonremote-126-[a-f0-9]{32}$/.test(pins.tag)
    || Object.keys(pins.assets ?? {}).length !== assetNames.length
    || approvedAssets.some(asset => !asset || !Number.isSafeInteger(asset.size)
      || asset.size < 70 || !/^[a-f0-9]{64}$/.test(asset.sha256))
    || new Set(approvedAssets.map(asset => asset.sha256)).size !== assetNames.length) {
    throw new ApprovalError("Exact approved draft and installer size/SHA-256 pins are required.");
  }
}

function readApprovedAssetIds(release, pins, verifiedManifest) {
  if (release?.id !== pins.id || release.draft !== true || release.published_at !== null
    || release.tag_name !== pins.tag) {
    throw new ApprovalError("GitHub release must be the approved unpublished draft.");
  }
  if (!Array.isArray(release.assets) || release.assets.length !== assetNames.length + Number(Boolean(verifiedManifest))) {
    throw new ApprovalError("The draft asset inventory differs from the approved inventory.");
  }

  const ids = assetNames.map(name => {
    const matches = release.assets.filter(asset => asset.name === name);
    const asset = matches[0];
    const pin = pins.assets[name];
    if (matches.length !== 1 || asset.state !== "uploaded" || asset.size !== pin.size
      || asset.digest !== "sha256:" + pin.sha256 || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new ApprovalError("Draft asset metadata changed or disagrees with its pin.");
    }
    return asset.id;
  });
  if (new Set(ids).size !== assetNames.length) {
    throw new ApprovalError("Draft asset IDs must be distinct.");
  }
  if (verifiedManifest) {
    const item = release.assets.find(asset => asset.name === manifestName);
    if (!item || item.id !== verifiedManifest.id || item.state !== "uploaded"
      || item.size !== verifiedManifest.size || item.digest !== verifiedManifest.digest) {
      throw new ApprovalError("The verified manifest was not found on the unpublished draft.");
    }
  }
  return ids;
}

function assertExecutableBytes(bytes, pin) {
  if (bytes.length !== pin.size || sha256(bytes) !== pin.sha256 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new ApprovalError("Downloaded installer bytes disagree with the approved x86 executable.");
  }
  const header = bytes.readUInt32LE(60);
  if (header + 6 > bytes.length || bytes.toString("binary", header, header + 4) !== "PE\0\0"
    || bytes.readUInt16LE(header + 4) !== 0x014c) {
    throw new ApprovalError("Downloaded installer does not have an x86 PE header.");
  }
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
  const [viewer, agent, fileUpdate] = paths;
  const commonArgs = [
    "--version", version, "--viewer-x64", viewer, "--agent-x64", agent, "--agent-update-x64", fileUpdate,
  ];
  runManifestScript("create-update-manifest.js", [
    ...commonArgs, "--release-tag", canonicalTag, "--force-update", "false", "--out", manifestPath,
  ], { WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY: key });
  runManifestScript("verify-release-manifest.js", [...commonArgs, "--manifest", manifestPath], {});

  const metadata = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const sections = ["viewerWindows", "agentInstallers", "agentFileUpdates"];
  const expectedPrefix = "https://github.com/" + repository + "/releases/download/" + canonicalTag + "/";
  if (metadata.version !== version || metadata.forceUpdate !== false
    || sections.some((section, index) => ["x86", "x64"].some(arch =>
      metadata[section]?.[arch]?.url !== expectedPrefix + assetNames[index]))) {
    throw new ApprovalError("Manifest disagrees with the production version, URL, or update policy.");
  }
}

export async function signDraftCandidate({
  context = process.env,
  pins = approvedDraft,
  fetchRequest = fetch,
  signAndVerify = generateAndVerifyManifest,
} = {}) {
  assertApproval(context, pins);
  if (!context.GH_TOKEN) {
    throw new ApprovalError("An authenticated workflow token is required.");
  }

  const request = (url, options = {}) => fetchRequest(url, {
    method: "GET",
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  const authorized = (url, options = {}, accept = "application/vnd.github+json") => request(url, {
    ...options,
    headers: {
      ...options.headers,
      accept,
      authorization: "Bearer " + context.GH_TOKEN,
      "x-github-api-version": "2022-11-28",
    },
  });
  const readDraft = async verifiedManifest => {
    const response = await authorized(gitHubApi + pins.id);
    if (response.status !== 200) throw new ApprovalError("Reading the approved draft metadata failed.");
    return readApprovedAssetIds(await response.json(), pins, verifiedManifest);
  };

  const firstAssetIds = await readDraft();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-126-draft-sign-"));
  try {
    const paths = assetNames.map(name => path.join(tempDir, name));
    for (const [index, name] of assetNames.entries()) {
      const pin = pins.assets[name];
      let response = await authorized(gitHubApi + "assets/" + firstAssetIds[index], {}, "application/octet-stream");
      if (response.status === 302) {
        const location = response.headers.get("location");
        const cdn = location && new URL(location);
        if (!cdn || cdn.protocol !== "https:" || !cdnHosts.has(cdn.host) || cdn.username || cdn.password) {
          throw new ApprovalError("GitHub asset redirected outside its release CDN.");
        }
        response = await request(cdn);
      }
      if (response.status !== 200 || Number(response.headers.get("content-length") ?? pin.size) !== pin.size) {
        throw new ApprovalError("Downloading the approved installer failed.");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      assertExecutableBytes(bytes, pin);
      fs.writeFileSync(paths[index], bytes, { mode: 0o600, flag: "wx" });
    }

    const manifestPath = path.join(tempDir, manifestName);
    signAndVerify({ paths, manifestPath, context });
    const manifest = fs.readFileSync(manifestPath);
    if ((await readDraft()).some((id, index) => id !== firstAssetIds[index])) {
      throw new ApprovalError("The approved draft changed during signing.");
    }

    const uploadUrl = "https://uploads.github.com/repos/" + repository + "/releases/" + pins.id
      + "/assets?name=" + manifestName;
    const response = await authorized(uploadUrl, {
      method: "POST",
      body: manifest,
      headers: { "content-type": "application/octet-stream" },
    });
    if (response.status !== 201) throw new ApprovalError("Writing the verified manifest to the draft failed.");
    const uploaded = await response.json();
    if (uploaded.name !== manifestName || uploaded.state !== "uploaded" || uploaded.size !== manifest.length
      || uploaded.digest !== "sha256:" + sha256(manifest) || !Number.isSafeInteger(uploaded.id) || uploaded.id <= 0) {
      throw new ApprovalError("The draft manifest upload response disagrees with the verified bytes.");
    }
    if ((await readDraft(uploaded)).some((id, index) => id !== firstAssetIds[index])) {
      throw new ApprovalError("The unpublished draft changed after the manifest was written.");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new ApprovalError("This signing job takes no command-line arguments.");
    await signDraftCandidate();
    console.log("Operating signature verified and uploaded to the approved unpublished draft.");
  } catch (error) {
    console.error(error instanceof ApprovalError ? error.message : "Candidate signing stopped; inspect the exact draft without retrying.");
    process.exitCode = 1;
  }
}
