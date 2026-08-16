import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS = ["viewer", "agent"];
const X86_RELEASE_DIRECTORY = path.join("i686-pc-windows-msvc", "release");
const X86_PE_MACHINE = 0x014c;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

export function peMachineForBuffer(buffer) {
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Expected a valid PE executable with an MZ header.");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("Expected a valid PE executable with a PE header.");
  }
  return buffer.readUInt16LE(peOffset + 4);
}

function readPackageVersion(appRoot) {
  return JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
}

export function createX86PayloadVerificationPlan({
  appRoot = defaultAppRoot,
  releaseDir = path.join(appRoot, "release-exe"),
  version = readPackageVersion(appRoot),
} = {}) {
  const installerDir = path.join(appRoot, "src-tauri", "target", X86_RELEASE_DIRECTORY, "bundle", "nsis");

  return PRODUCTS.map((product) => {
    const productName = product === "agent" ? "Agent" : "Viewer";
    return {
      product,
      releasedInstallerPath: path.join(releaseDir, `WonRemote-${productName}-Setup.exe`),
      x86InstallerPath: path.join(installerDir, `WonRemote ${productName}_${version}_x86-setup.exe`),
      expectedPeMachine: X86_PE_MACHINE,
    };
  });
}

export async function verifyX86InstallerPayloads(options = {}) {
  const plans = createX86PayloadVerificationPlan(options);

  return plans.map((plan) => {
    ensureFile(plan.releasedInstallerPath, `released ${plan.product} installer`);
    ensureFile(plan.x86InstallerPath, `current x86 ${plan.product} installer`);

    const x86Machine = peMachineForBuffer(fs.readFileSync(plan.x86InstallerPath));
    if (x86Machine !== plan.expectedPeMachine) {
      throw new Error(
        `x86 ${plan.product} installer PE machine mismatch: expected 0x${plan.expectedPeMachine.toString(16)}, got 0x${x86Machine.toString(16)}.`,
      );
    }

    const releasedMachine = peMachineForBuffer(fs.readFileSync(plan.releasedInstallerPath));
    if (releasedMachine !== plan.expectedPeMachine) {
      throw new Error(
        `released ${plan.product} installer is not an x86 build: expected PE machine 0x${plan.expectedPeMachine.toString(16)}, got 0x${releasedMachine.toString(16)}.`,
      );
    }

    const expectedSha256 = sha256File(plan.x86InstallerPath);
    const releasedSha256 = sha256File(plan.releasedInstallerPath);
    if (releasedSha256 !== expectedSha256) {
      throw new Error(
        `released ${plan.product} installer does not match the current x86 build output: expected ${expectedSha256}, got ${releasedSha256}.`,
      );
    }

    return {
      product: plan.product,
      installerPath: plan.releasedInstallerPath,
      sourceInstallerPath: plan.x86InstallerPath,
      sha256: releasedSha256,
      peMachine: releasedMachine,
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await verifyX86InstallerPayloads();
  for (const result of results) {
    console.log(`Verified ${result.product} x86 installer payload: ${result.sha256}`);
  }
}
