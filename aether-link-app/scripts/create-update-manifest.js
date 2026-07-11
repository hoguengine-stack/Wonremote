import { createHash, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const stableInstallerAssetName = "WonRemote-Viewer-Agent-Setup.exe";
const stableInstallerAssetNameX86 = "WonRemote-Viewer-Agent-Setup-x86.exe";
const stablePortableAssetName = "WonRemote-Viewer-Agent-Portable.zip";
const stablePortableAssetNameX86 = "WonRemote-Viewer-Agent-Portable-x86.zip";
const stablePortableAgentAssetName = "WonRemote-Agent-Portable.zip";
const stablePortableAgentAssetNameX86 = "WonRemote-Agent-Portable-x86.zip";

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
  const releasePath = tag ? `download/${tag}` : "latest/download";
  return `https://github.com/${repository}/releases/${releasePath}/${encodeURIComponent(assetName)}`;
}

function normalizeGitHubAssetName(assetName) {
  return assetName.replace(/\s+/g, ".");
}

function assetNameFromDownloadUrl(downloadUrl) {
  try {
    return normalizeGitHubAssetName(decodeURIComponent(path.basename(new URL(downloadUrl).pathname)));
  } catch {
    return stableInstallerAssetName;
  }
}

function defaultInstallerPath(version) {
  return path.join(appRoot, "release-exe", stableInstallerAssetName);
}

function defaultInstallerPathX86() {
  return path.join(appRoot, "release-exe", stableInstallerAssetNameX86);
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
const installerPath = path.resolve(args.get("--installer") || defaultInstallerPath(version));
const installerPathX86 = path.resolve(args.get("--installer-x86") || defaultInstallerPathX86(version));
const portablePath = path.resolve(args.get("--portable-x64") || defaultReleaseAssetPath(stablePortableAssetName));
const portablePathX86 = path.resolve(args.get("--portable-x86") || defaultReleaseAssetPath(stablePortableAssetNameX86));
const portableAgentPath = path.resolve(
  args.get("--portable-agent-x64") || defaultReleaseAssetPath(stablePortableAgentAssetName),
);
const portableAgentPathX86 = path.resolve(
  args.get("--portable-agent-x86") || defaultReleaseAssetPath(stablePortableAgentAssetNameX86),
);
const outPath = path.resolve(args.get("--out") || defaultOutputPath());
const assetName = normalizeGitHubAssetName(
  args.get("--asset-name") || (args.get("--download-url") ? assetNameFromDownloadUrl(args.get("--download-url")) : stableInstallerAssetName),
);
const assetNameX86 = normalizeGitHubAssetName(
  args.get("--asset-name-x86") || (args.get("--download-url-x86") ? assetNameFromDownloadUrl(args.get("--download-url-x86")) : stableInstallerAssetNameX86),
);
const portableAssetName = normalizeGitHubAssetName(
  args.get("--portable-asset-name-x64") || stablePortableAssetName,
);
const portableAssetNameX86 = normalizeGitHubAssetName(
  args.get("--portable-asset-name-x86") || stablePortableAssetNameX86,
);
const portableAgentAssetName = normalizeGitHubAssetName(
  args.get("--portable-agent-asset-name-x64") || stablePortableAgentAssetName,
);
const portableAgentAssetNameX86 = normalizeGitHubAssetName(
  args.get("--portable-agent-asset-name-x86") || stablePortableAgentAssetNameX86,
);
const downloadUrl = buildDownloadUrl(args, version, assetName, "--download-url");
const downloadUrlX86 = buildDownloadUrl(args, version, assetNameX86, "--download-url-x86");
const portableDownloadUrl = buildDownloadUrl(
  args,
  version,
  portableAssetName,
  "--portable-download-url-x64",
);
const portableDownloadUrlX86 = buildDownloadUrl(
  args,
  version,
  portableAssetNameX86,
  "--portable-download-url-x86",
);
const portableAgentDownloadUrl = buildDownloadUrl(
  args,
  version,
  portableAgentAssetName,
  "--portable-agent-download-url-x64",
);
const portableAgentDownloadUrlX86 = buildDownloadUrl(
  args,
  version,
  portableAgentAssetNameX86,
  "--portable-agent-download-url-x86",
);

if (!downloadUrl.startsWith("https://")) {
  throw new Error("The update installer download URL must use HTTPS.");
}
if (!fs.existsSync(installerPath)) {
  throw new Error(`Installer not found: ${installerPath}`);
}

for (const [label, assetPath] of [
  ["x64 portable Viewer+Agent ZIP", portablePath],
  ["x86 portable Viewer+Agent ZIP", portablePathX86],
  ["x64 portable Agent ZIP", portableAgentPath],
  ["x86 portable Agent ZIP", portableAgentPathX86],
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

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  forceUpdate,
  windows: {
    x64: buildSignedAsset({ arch: "x64", assetName, downloadUrl, filePath: installerPath, updateKind: "installer" }),
  },
  portable: {
    x64: buildSignedAsset({
      assetName: portableAssetName,
      downloadUrl: portableDownloadUrl,
      filePath: portablePath,
      arch: "x64",
      updateKind: "portable",
    }),
    x86: buildSignedAsset({
      assetName: portableAssetNameX86,
      downloadUrl: portableDownloadUrlX86,
      filePath: portablePathX86,
      arch: "x86",
      updateKind: "portable",
    }),
  },
  portableAgent: {
    x64: buildSignedAsset({
      assetName: portableAgentAssetName,
      downloadUrl: portableAgentDownloadUrl,
      filePath: portableAgentPath,
      arch: "x64",
      updateKind: "portable-agent",
    }),
    x86: buildSignedAsset({
      assetName: portableAgentAssetNameX86,
      downloadUrl: portableAgentDownloadUrlX86,
      filePath: portableAgentPathX86,
      arch: "x86",
      updateKind: "portable-agent",
    }),
  },
};

if (args.has("--installer-x86") || fs.existsSync(installerPathX86)) {
  if (!fs.existsSync(installerPathX86)) {
    throw new Error(`x86 installer not found: ${installerPathX86}`);
  }
  manifest.windows.x86 = buildSignedAsset({
    assetName: assetNameX86,
    downloadUrl: downloadUrlX86,
    filePath: installerPathX86,
    arch: "x86",
    updateKind: "installer",
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Production update manifest written to ${outPath}`);
console.log(`Installer SHA-256: ${manifest.windows.x64.sha256}`);
if (manifest.windows.x86) {
  console.log(`x86 installer SHA-256: ${manifest.windows.x86.sha256}`);
}
console.log(`x64 portable Viewer+Agent SHA-256: ${manifest.portable.x64.sha256}`);
console.log(`x86 portable Viewer+Agent SHA-256: ${manifest.portable.x86.sha256}`);
console.log(`x64 portable Agent SHA-256: ${manifest.portableAgent.x64.sha256}`);
console.log(`x86 portable Agent SHA-256: ${manifest.portableAgent.x86.sha256}`);
