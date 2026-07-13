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

function readAsset(manifest, section, arch) {
  const asset = manifest?.[section]?.[arch];
  if (!asset || typeof asset !== "object") {
    throw new Error(`Release manifest is missing ${section}.${arch}.`);
  }
  return asset;
}

function urlAssetName(value, fieldName) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("not HTTPS");
    }
    return decodeURIComponent(path.basename(url.pathname));
  } catch {
    throw new Error(`Release manifest ${fieldName}.url must be a valid HTTPS asset URL.`);
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
  const fieldName = `${input.section}.${input.arch}`;
  if (!fs.existsSync(input.filePath)) {
    throw new Error(`${fieldName} release asset is missing: ${input.filePath}`);
  }
  const asset = readAsset(manifest, input.section, input.arch);
  if (asset.name !== input.expectedName) {
    throw new Error(`${fieldName}.name is ${String(asset.name)}; expected ${input.expectedName}.`);
  }
  if (urlAssetName(asset.url, fieldName) !== input.expectedName) {
    throw new Error(`${fieldName}.url does not target ${input.expectedName}.`);
  }
  if (typeof asset.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.signature)) {
    throw new Error(`${fieldName}.signature is missing or invalid.`);
  }
  if (typeof asset.signatureV2 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.signatureV2)) {
    throw new Error(`${fieldName}.signatureV2 is missing or invalid.`);
  }
  const expectedChecksum = typeof asset.sha256 === "string" ? asset.sha256.toLowerCase() : "";
  const actualChecksum = await sha256File(input.filePath);
  if (expectedChecksum !== actualChecksum) {
    throw new Error(
      `${fieldName}.sha256 does not match ${input.filePath}: expected ${expectedChecksum}, actual ${actualChecksum}.`,
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
    throw new Error(`${fieldName}.signature does not match the trusted update public key.`);
  }
  const signaturePayloadV2 = [
    "signatureVersion=2",
    `version=${manifest.version}`,
    `url=${asset.url}`,
    `sha256=${expectedChecksum}`,
    `assetName=${asset.name}`,
    `forceUpdate=${manifest.forceUpdate === true ? "true" : "false"}`,
    `updateKind=${input.section === "portable" ? "portable" : input.section === "portableAgent" ? "portable-agent" : "installer"}`,
    `arch=${input.arch}`,
  ].join("\n");
  const signatureV2Valid = verify(
    null,
    Buffer.from(signaturePayloadV2, "utf8"),
    publicKey,
    Buffer.from(asset.signatureV2, "base64"),
  );
  if (!signatureV2Valid) {
    throw new Error(`${fieldName}.signatureV2 does not match signed update policy metadata.`);
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
  section: "viewerWindows",
  filePath: path.resolve(requiredArg(args, "--viewer-x64")),
  expectedName: args.get("--viewer-asset-name-x64") || "WonRemote-Viewer-Setup.exe",
});
await verifyAsset(manifest, {
  arch: "x86",
  section: "viewerWindows",
  filePath: path.resolve(requiredArg(args, "--viewer-x86")),
  expectedName: args.get("--viewer-asset-name-x86") || "WonRemote-Viewer-Setup-x86.exe",
});
await verifyAsset(manifest, {
  arch: "x64",
  section: "agentWindows",
  filePath: path.resolve(requiredArg(args, "--agent-x64")),
  expectedName: args.get("--agent-asset-name-x64") || "WonRemote-Agent-Setup.exe",
});
await verifyAsset(manifest, {
  arch: "x86",
  section: "agentWindows",
  filePath: path.resolve(requiredArg(args, "--agent-x86")),
  expectedName: args.get("--agent-asset-name-x86") || "WonRemote-Agent-Setup-x86.exe",
});

for (const arch of ["x64", "x86"]) {
  if (JSON.stringify(manifest.windows?.[arch]) !== JSON.stringify(manifest.viewerWindows?.[arch])) {
    throw new Error(`Release manifest windows.${arch} compatibility metadata must match viewerWindows.${arch}.`);
  }
}

console.log(`Verified release manifest ${manifestPath} for ${version} (four Viewer/Agent installers, x64 and x86).`);
