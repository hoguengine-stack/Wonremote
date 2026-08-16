import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sevenZipBin from "7zip-bin";
import { createUniversalProductInstallerScript } from "./package-release-exes.js";

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS = ["viewer", "agent"];
const ARCHITECTURES = {
  x64: { releaseDirectory: "release", installerArch: "x64", peMachine: 0x8664 },
  x86: { releaseDirectory: path.join("i686-pc-windows-msvc", "release"), installerArch: "x86", peMachine: 0x014c },
};
const FULL_7ZIP_VERSION = "26.02";
const FULL_7ZIP_URL = "https://www.7-zip.org/a/7z2602-x64.exe";
const FULL_7ZIP_SHA256 = "6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0";

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`7-Zip verifier download failed: HTTP ${response.status}`);
  }
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function resolveFullSevenZipPath(appRoot) {
  const toolRoot = path.join(appRoot, ".local-run", "7zip-verifier", FULL_7ZIP_VERSION);
  const archivePath = path.join(toolRoot, "7zip-installer.exe");
  const executablePath = path.join(toolRoot, "7z.exe");
  const libraryPath = path.join(toolRoot, "7z.dll");
  fs.mkdirSync(toolRoot, { recursive: true });
  if (!fs.existsSync(archivePath)) {
    await downloadFile(FULL_7ZIP_URL, archivePath);
  }
  const archiveHash = sha256File(archivePath);
  if (archiveHash !== FULL_7ZIP_SHA256) {
    throw new Error(`Official 7-Zip verifier checksum mismatch: expected ${FULL_7ZIP_SHA256}, got ${archiveHash}.`);
  }
  if (!fs.existsSync(executablePath) || !fs.existsSync(libraryPath)) {
    execFileSync(sevenZipBin.path7za, ["x", archivePath, `-o${toolRoot}`, "-y"], {
      stdio: "pipe",
      windowsHide: true,
    });
  }
  ensureFile(executablePath, "full 7-Zip verifier executable");
  ensureFile(libraryPath, "full 7-Zip verifier library");
  return executablePath;
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

function resolveMakensisPath() {
  const candidates = [
    process.env.WONREMOTE_MAKENSIS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS", "Bin", "makensis.exe") : undefined,
    "makensis.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "makensis.exe" || fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("makensis.exe is required to verify universal installer payloads.");
}

export function createUniversalPayloadVerificationPlan({
  appRoot = defaultAppRoot,
  releaseDir = path.join(appRoot, "release-exe"),
  version = readPackageVersion(appRoot),
} = {}) {
  const packagePaths = {};
  for (const [architecture, target] of Object.entries(ARCHITECTURES)) {
    const installerDirectory = path.join(appRoot, "src-tauri", "target", target.releaseDirectory, "bundle", "nsis");
    packagePaths[architecture] = {
      viewerInstallerPath: path.join(installerDirectory, `WonRemote Viewer_${version}_${target.installerArch}-setup.exe`),
      agentInstallerPath: path.join(installerDirectory, `WonRemote Agent_${version}_${target.installerArch}-setup.exe`),
      expectedPeMachine: target.peMachine,
    };
  }

  return PRODUCTS.map((product) => ({
    product,
    actualInstallerPath: path.join(releaseDir, `WonRemote-${product === "agent" ? "Agent" : "Viewer"}-Setup.exe`),
    packagePaths,
  }));
}

function compileExpectedWrapper({ plan, outputPath, workspace, compileNsis }) {
  const scriptPath = path.join(workspace, `WonRemote-${plan.product}-payload-proof.nsi`);
  const script = createUniversalProductInstallerScript(plan.packagePaths, plan.product, outputPath);
  fs.writeFileSync(scriptPath, script, "utf8");
  compileNsis(scriptPath);
  ensureFile(outputPath, `compiled ${plan.product} payload proof`);
  return { outputPath, script };
}

function extractHostExecutableWithSevenZip(sevenZipPath, installerPath, outputPath) {
  const extractionRoot = path.dirname(outputPath);
  fs.mkdirSync(extractionRoot, { recursive: true });
  execFileSync(sevenZipPath, ["x", installerPath, `-o${extractionRoot}`, "-y", "wonremote-viewer.exe"], {
    stdio: "pipe",
    windowsHide: true,
  });
  ensureFile(outputPath, `extracted Tauri host from ${path.basename(installerPath)}`);
}

function defaultCompileNsis(scriptPath) {
  execFileSync(resolveMakensisPath(), [scriptPath], {
    stdio: "pipe",
    windowsHide: true,
  });
}

export async function verifyUniversalInstallerPayloads(options = {}) {
  const plans = createUniversalPayloadVerificationPlan(options);
  const compileNsis = options.compileNsis ?? defaultCompileNsis;
  const sevenZipPath = options.extractHostExecutable
    ? undefined
    : await resolveFullSevenZipPath(options.appRoot ?? defaultAppRoot);
  const extractHostExecutable = options.extractHostExecutable
    ?? ((installerPath, outputPath) => extractHostExecutableWithSevenZip(sevenZipPath, installerPath, outputPath));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-universal-payload-proof-"));

  try {
    return plans.map((plan) => {
      ensureFile(plan.actualInstallerPath, `released ${plan.product} universal installer`);
      for (const architecture of Object.keys(ARCHITECTURES)) {
        ensureFile(plan.packagePaths[architecture].viewerInstallerPath, `${architecture} Viewer inner installer`);
        ensureFile(plan.packagePaths[architecture].agentInstallerPath, `${architecture} Agent inner installer`);
        for (const product of PRODUCTS) {
          const installerPath = plan.packagePaths[architecture][`${product}InstallerPath`];
          const extractedHostPath = path.join(temporaryRoot, "inner-hosts", architecture, product, "wonremote-viewer.exe");
          extractHostExecutable(installerPath, extractedHostPath);
          const extractedBuffer = fs.readFileSync(extractedHostPath);
          const extractedMachine = peMachineForBuffer(extractedBuffer);
          if (extractedMachine !== plan.packagePaths[architecture].expectedPeMachine) {
            throw new Error(
              `${architecture} ${product} inner installer PE machine mismatch: expected 0x${plan.packagePaths[architecture].expectedPeMachine.toString(16)}, got 0x${extractedMachine.toString(16)}.`,
            );
          }
        }
      }

      const firstOutputPath = path.join(temporaryRoot, `${plan.product}-first.exe`);
      const secondOutputPath = path.join(temporaryRoot, `${plan.product}-second.exe`);
      const first = compileExpectedWrapper({ plan, outputPath: firstOutputPath, workspace: temporaryRoot, compileNsis });
      const second = compileExpectedWrapper({ plan, outputPath: secondOutputPath, workspace: temporaryRoot, compileNsis });
      const firstHash = sha256File(first.outputPath);
      const secondHash = sha256File(second.outputPath);
      const actualHash = sha256File(plan.actualInstallerPath);

      if (firstHash !== secondHash) {
        throw new Error(`NSIS output is not deterministic for ${plan.product}; cannot prove payload equality.`);
      }
      if (actualHash !== firstHash) {
        throw new Error(`Released ${plan.product} installer does not match the x64/x86 inner payload sources.`);
      }

      return {
        product: plan.product,
        installerPath: plan.actualInstallerPath,
        sha256: actualHash,
        sourceInnerInstallers: {
          viewer: {
            x64: sha256File(plan.packagePaths.x64.viewerInstallerPath),
            x86: sha256File(plan.packagePaths.x86.viewerInstallerPath),
          },
          agent: {
            x64: sha256File(plan.packagePaths.x64.agentInstallerPath),
            x86: sha256File(plan.packagePaths.x86.agentInstallerPath),
          },
        },
        sourceHostMachines: {
          x64: plan.packagePaths.x64.expectedPeMachine,
          x86: plan.packagePaths.x86.expectedPeMachine,
        },
      };
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await verifyUniversalInstallerPayloads();
  for (const result of results) {
    console.log(`Verified ${result.product} universal installer payloads: ${result.sha256}`);
  }
}
