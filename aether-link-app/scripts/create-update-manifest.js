import { createHash, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const stableViewerAssetName = "WonRemote-Viewer-Setup.exe";
const stableAgentAssetName = "WonRemote-Agent-Setup.exe";

function readArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (key.includes("=")) {
      const [name, ...valueParts] = key.split("=");
      const value = valueParts.join("=");
      if (!value) {
        throw new Error(`Missing value for ${name}`);
      }
      args.set(name, value);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function readPrivateKey(args) {
  const fromArg = args.get("--private-key");
  const fromEnv = process.env.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY;
  const keySource = fromArg || fromEnv;
  if (!keySource) {
    throw new Error("Missing update signing private key. Pass --private-key or set WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY.");
  }
  if (keySource.includes("BEGIN PRIVATE KEY")) {
    return keySource;
  }
  return fs.readFileSync(path.resolve(keySource), "utf8");
}

function buildDownloadUrl(args, version, assetName, explicitUrlArg) {
  const explicitUrl = args.get(explicitUrlArg);
  if (explicitUrl) {
    return explicitUrl;
  }
  const repository = args.get("--repository") || "hoguengine-stack/Wonremote";
  const tag = args.get("--release-tag");
  const releasePath = `download/${tag || `v${version}`}`;
  return `https://github.com/${repository}/releases/${releasePath}/${encodeURIComponent(assetName)}`;
}

function normalizeGitHubAssetName(assetName) {
  return assetName.replace(/\s+/g, ".");
}

function assetNameFromDownloadUrl(downloadUrl) {
  try {
    return normalizeGitHubAssetName(decodeURIComponent(path.basename(new URL(downloadUrl).pathname)));
  } catch {
    return stableViewerAssetName;
  }
}

function defaultInstallerPath(version) {
  return path.join(appRoot, "release-exe", stableViewerAssetName);
}

function defaultReleaseAssetPath(assetName) {
  return path.join(appRoot, "release-exe", assetName);
}

function defaultOutputPath() {
  return path.join(appRoot, "release-exe", "wonremote-update-manifest.json");
}

function buildSignaturePayload(input) {
  return [
    `version=${input.latestVersion}`,
    `url=${input.downloadUrl}`,
    `sha256=${input.checksum.toLowerCase()}`,
    `assetName=${input.assetName}`,
  ].join("\n");
}

function buildSignaturePayloadV2(input) {
  return [
    "signatureVersion=2",
    `version=${input.latestVersion}`,
    `url=${input.downloadUrl}`,
    `sha256=${input.checksum.toLowerCase()}`,
    `assetName=${input.assetName}`,
    `forceUpdate=${input.forceUpdate ? "true" : "false"}`,
    `updateKind=${input.updateKind}`,
    `arch=${input.arch}`,
  ].join("\n");
}

const args = readArgs(process.argv.slice(2));
const version = args.get("--version") || packageJson.version;
const forceUpdate = args.get("--force-update") === "true";
const viewerPath = path.resolve(args.get("--viewer-x64") || args.get("--installer") || defaultInstallerPath(version));
const viewerPathX86 = path.resolve(args.get("--viewer-x86") || args.get("--installer-x86") || viewerPath);
const agentPath = path.resolve(args.get("--agent-x64") || defaultReleaseAssetPath(stableAgentAssetName));
const agentPathX86 = path.resolve(args.get("--agent-x86") || agentPath);
const outPath = path.resolve(args.get("--out") || defaultOutputPath());
const viewerAssetName = normalizeGitHubAssetName(
  args.get("--viewer-asset-name-x64") || args.get("--asset-name") || stableViewerAssetName,
);
const viewerAssetNameX86 = normalizeGitHubAssetName(
  args.get("--viewer-asset-name-x86") || args.get("--asset-name-x86") || viewerAssetName,
);
const agentAssetName = normalizeGitHubAssetName(
  args.get("--agent-asset-name-x64") || stableAgentAssetName,
);
const agentAssetNameX86 = normalizeGitHubAssetName(
  args.get("--agent-asset-name-x86") || agentAssetName,
);
const viewerDownloadUrl = buildDownloadUrl(args, version, viewerAssetName, "--viewer-download-url-x64");
const viewerDownloadUrlX86 = buildDownloadUrl(args, version, viewerAssetNameX86, "--viewer-download-url-x86");
const agentDownloadUrl = buildDownloadUrl(args, version, agentAssetName, "--agent-download-url-x64");
const agentDownloadUrlX86 = buildDownloadUrl(args, version, agentAssetNameX86, "--agent-download-url-x86");

for (const [label, assetPath] of [
  ["x64 Viewer installer", viewerPath],
  ["x86 Viewer installer", viewerPathX86],
  ["x64 Agent installer", agentPath],
  ["x86 Agent installer", agentPathX86],
]) {
  if (!fs.existsSync(assetPath)) {
    throw new Error(`${label} not found: ${assetPath}`);
  }
}

const privateKeyPem = readPrivateKey(args);

function buildSignedAsset({ arch, assetName, downloadUrl, filePath, updateKind }) {
  if (!downloadUrl.startsWith("https://")) {
    throw new Error("The update installer download URL must use HTTPS.");
  }
  const assetBytes = fs.readFileSync(filePath);
  const checksum = createHash("sha256").update(assetBytes).digest("hex");
  const payload = buildSignaturePayload({
    assetName,
    checksum,
    downloadUrl,
    latestVersion: version,
  });
  const payloadV2 = buildSignaturePayloadV2({
    arch,
    assetName,
    checksum,
    downloadUrl,
    forceUpdate,
    latestVersion: version,
    updateKind,
  });
  return {
    name: assetName,
    url: downloadUrl,
    sha256: checksum,
    signature: sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64"),
    signatureV2: sign(null, Buffer.from(payloadV2, "utf8"), privateKeyPem).toString("base64"),
  };
}

const viewerX64 = buildSignedAsset({
  arch: "x64", assetName: viewerAssetName, downloadUrl: viewerDownloadUrl, filePath: viewerPath, updateKind: "installer",
});
const viewerX86 = buildSignedAsset({
  arch: "x86", assetName: viewerAssetNameX86, downloadUrl: viewerDownloadUrlX86, filePath: viewerPathX86, updateKind: "installer",
});
const agentX64 = buildSignedAsset({
  arch: "x64", assetName: agentAssetName, downloadUrl: agentDownloadUrl, filePath: agentPath, updateKind: "installer",
});
const agentX86 = buildSignedAsset({
  arch: "x86", assetName: agentAssetNameX86, downloadUrl: agentDownloadUrlX86, filePath: agentPathX86, updateKind: "installer",
});

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  forceUpdate,
  windows: {
    x64: viewerX64,
    x86: viewerX86,
  },
  viewerWindows: {
    x64: viewerX64,
    x86: viewerX86,
  },
  agentWindows: {
    x64: agentX64,
    x86: agentX86,
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Production update manifest written to ${outPath}`);
console.log(`x64 Viewer SHA-256: ${manifest.viewerWindows.x64.sha256}`);
console.log(`x86 Viewer SHA-256: ${manifest.viewerWindows.x86.sha256}`);
console.log(`x64 Agent SHA-256: ${manifest.agentWindows.x64.sha256}`);
console.log(`x86 Agent SHA-256: ${manifest.agentWindows.x86.sha256}`);
