import { createHash, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const stableInstallerAssetName = "WonRemote-Viewer-Agent-Setup.exe";

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

function buildDownloadUrl(args, version, assetName) {
  const explicitUrl = args.get("--download-url");
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

const args = readArgs(process.argv.slice(2));
const version = args.get("--version") || packageJson.version;
const installerPath = path.resolve(args.get("--installer") || defaultInstallerPath(version));
const outPath = path.resolve(args.get("--out") || defaultOutputPath());
const assetName = normalizeGitHubAssetName(
  args.get("--asset-name") || (args.get("--download-url") ? assetNameFromDownloadUrl(args.get("--download-url")) : stableInstallerAssetName),
);
const downloadUrl = buildDownloadUrl(args, version, assetName);

if (!downloadUrl.startsWith("https://")) {
  throw new Error("The update installer download URL must use HTTPS.");
}
if (!fs.existsSync(installerPath)) {
  throw new Error(`Installer not found: ${installerPath}`);
}

const installerBytes = fs.readFileSync(installerPath);
const checksum = createHash("sha256").update(installerBytes).digest("hex");
const privateKeyPem = readPrivateKey(args);
const payload = buildSignaturePayload({
  assetName,
  checksum,
  downloadUrl,
  latestVersion: version,
});
const signature = sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  windows: {
    x64: {
      name: assetName,
      url: downloadUrl,
      sha256: checksum,
      signature,
    },
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Production update manifest written to ${outPath}`);
console.log(`Installer SHA-256: ${checksum}`);
