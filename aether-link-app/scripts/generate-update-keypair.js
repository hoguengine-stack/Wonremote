import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultKeyDir = path.join(appRoot, ".local-run", "update-signing");

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
    if (key === "--force") {
      args.set(key, "true");
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

const args = readArgs(process.argv.slice(2));
const privateKeyPath = path.resolve(args.get("--private-key") || path.join(defaultKeyDir, "update-signing-private.pem"));
const publicKeyPath = path.resolve(args.get("--public-key") || path.join(defaultKeyDir, "update-signing-public.pem"));
const force = args.get("--force") === "true";

for (const targetPath of [privateKeyPath, publicKeyPath]) {
  if (fs.existsSync(targetPath) && !force) {
    throw new Error(`${targetPath} already exists. Pass --force only when rotating the update signing key intentionally.`);
  }
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true });
fs.mkdirSync(path.dirname(publicKeyPath), { recursive: true });
fs.writeFileSync(privateKeyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKeyPem, "utf8");

console.log(`Private update signing key written to ${privateKeyPath}`);
console.log(`Public update verification key written to ${publicKeyPath}`);
console.log("Keep the private key out of git. Update src/domain/updateTrust.ts with the public PEM when rotating keys.");
