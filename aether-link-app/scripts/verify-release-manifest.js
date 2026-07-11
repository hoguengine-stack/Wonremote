import { createHash, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAwwhk0hWhfnVUQc8DS6XsT1XGaFNLBa94h//lHmRPIzY=",
  "-----END PUBLIC KEY-----",
].join("\n");

function readArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name value argument near ${key ?? "<end>"}.`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`Missing required argument ${name}.`);
  }
  return value;
}

function readAsset(manifest, arch) {
  const asset = manifest?.windows?.[arch];
  if (!asset || typeof asset !== "object") {
    throw new Error(`Release manifest is missing windows.${arch}.`);
  }
  return asset;
}

function urlAssetName(value, arch) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("not HTTPS");
    }
    return decodeURIComponent(path.basename(url.pathname));
  } catch {
    throw new Error(`Release manifest windows.${arch}.url must be a valid HTTPS asset URL.`);
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function verifyAsset(manifest, input) {
  if (!fs.existsSync(input.installerPath)) {
    throw new Error(`${input.arch} installer is missing: ${input.installerPath}`);
  }
  const asset = readAsset(manifest, input.arch);
  if (asset.name !== input.expectedName) {
    throw new Error(`windows.${input.arch}.name is ${String(asset.name)}; expected ${input.expectedName}.`);
  }
  if (urlAssetName(asset.url, input.arch) !== input.expectedName) {
    throw new Error(`windows.${input.arch}.url does not target ${input.expectedName}.`);
  }
  if (typeof asset.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.signature)) {
    throw new Error(`windows.${input.arch}.signature is missing or invalid.`);
  }
  const expectedChecksum = typeof asset.sha256 === "string" ? asset.sha256.toLowerCase() : "";
  const actualChecksum = await sha256File(input.installerPath);
  if (expectedChecksum !== actualChecksum) {
    throw new Error(
      `windows.${input.arch}.sha256 does not match ${input.installerPath}: expected ${expectedChecksum}, actual ${actualChecksum}.`,
    );
  }
  const signaturePayload = [
    `version=${manifest.version}`,
    `url=${asset.url}`,
    `sha256=${expectedChecksum}`,
    `assetName=${asset.name}`,
  ].join("\n");
  const publicKey = process.env.WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY?.trim() || BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY;
  const signatureValid = verify(
    null,
    Buffer.from(signaturePayload, "utf8"),
    publicKey,
    Buffer.from(asset.signature, "base64"),
  );
  if (!signatureValid) {
    throw new Error(`windows.${input.arch}.signature does not match the trusted update public key.`);
  }
}

const args = readArgs(process.argv.slice(2));
const manifestPath = path.resolve(requiredArg(args, "--manifest"));
const version = requiredArg(args, "--version");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) {
  throw new Error(`Release manifest version is ${String(manifest.version)}; expected ${version}.`);
}

await verifyAsset(manifest, {
  arch: "x64",
  installerPath: path.resolve(requiredArg(args, "--installer-x64")),
  expectedName: args.get("--asset-name-x64") || "WonRemote-Viewer-Agent-Setup.exe",
});
await verifyAsset(manifest, {
  arch: "x86",
  installerPath: path.resolve(requiredArg(args, "--installer-x86")),
  expectedName: args.get("--asset-name-x86") || "WonRemote-Viewer-Agent-Setup-x86.exe",
});

console.log(`Verified release manifest ${manifestPath} for ${version} (x64 and x86).`);
