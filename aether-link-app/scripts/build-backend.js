import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");
const nodeEsmRequireBanner = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";
const buildArch = resolveBuildArch();
const nodeRuntimeVersion = process.env.WONREMOTE_NODE_RUNTIME_VERSION || "20.19.5";
const cmakeVersion = process.env.WONREMOTE_CMAKE_VERSION || "3.31.8";
const nasmVersion = process.env.WONREMOTE_NASM_VERSION || "2.16.03";

function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
}

function resolveBuildArch() {
  const value = process.env.WONREMOTE_BUILD_ARCH?.trim().toLowerCase();
  return value === "ia32" || value === "x86" ? "ia32" : "x64";
}

function readPeMachine(filePath) {
  const bytes = fs.readFileSync(filePath);
  const peOffset = bytes.readInt32LE(0x3c);
  return bytes.readUInt16LE(peOffset + 4);
}

function assertPeMachine(filePath, expectedMachine, label) {
  const actualMachine = readPeMachine(filePath);
  if (actualMachine !== expectedMachine) {
    throw new Error(`${label} has unexpected PE machine 0x${actualMachine.toString(16)}; expected 0x${expectedMachine.toString(16)}.`);
  }
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function resolveIa32NodeRuntime() {
  const overridePath = process.env.WONREMOTE_NODE_RUNTIME_IA32 || process.env.WONREMOTE_NODE_RUNTIME_PATH;
  if (overridePath) {
    return path.resolve(overridePath);
  }

  const cacheRoot = path.join(appRoot, ".local-run", "node-runtimes");
  const archivePath = path.join(cacheRoot, `node-v${nodeRuntimeVersion}-win-x86.zip`);
  const extractedDir = path.join(cacheRoot, `node-v${nodeRuntimeVersion}-win-x86`);
  const nodePath = path.join(extractedDir, "node.exe");
  if (!fs.existsSync(nodePath)) {
    const downloadUrl = `https://nodejs.org/dist/v${nodeRuntimeVersion}/node-v${nodeRuntimeVersion}-win-x86.zip`;
    console.log(`Downloading 32-bit Node runtime from ${downloadUrl}...`);
    await downloadFile(downloadUrl, archivePath);
    fs.rmSync(extractedDir, { recursive: true, force: true });
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${cacheRoot.replace(/'/g, "''")}' -Force`,
    ], appRoot);
  }
  return nodePath;
}

async function resolvePortableCmakeBinDir() {
  const overridePath = process.env.WONREMOTE_CMAKE_BIN_DIR;
  if (overridePath) {
    return path.resolve(overridePath);
  }

  const cacheRoot = path.join(appRoot, ".local-run", "cmake");
  const archiveName = `cmake-${cmakeVersion}-windows-x86_64.zip`;
  const archivePath = path.join(cacheRoot, archiveName);
  const extractedDir = path.join(cacheRoot, `cmake-${cmakeVersion}-windows-x86_64`);
  const cmakeBinDir = path.join(extractedDir, "bin");
  const cmakeExe = path.join(cmakeBinDir, "cmake.exe");
  if (!fs.existsSync(cmakeExe)) {
    const downloadUrl = `https://github.com/Kitware/CMake/releases/download/v${cmakeVersion}/${archiveName}`;
    console.log(`Downloading portable CMake from ${downloadUrl}...`);
    await downloadFile(downloadUrl, archivePath);
    fs.rmSync(extractedDir, { recursive: true, force: true });
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${cacheRoot.replace(/'/g, "''")}' -Force`,
    ], appRoot);
  }
  return cmakeBinDir;
}

async function resolvePortableNasmBinDir() {
  const overridePath = process.env.WONREMOTE_NASM_BIN_DIR;
  if (overridePath) {
    return path.resolve(overridePath);
  }

  const cacheRoot = path.join(appRoot, ".local-run", "nasm");
  const archiveName = `nasm-${nasmVersion}-win64.zip`;
  const archivePath = path.join(cacheRoot, archiveName);
  const extractedDir = path.join(cacheRoot, `nasm-${nasmVersion}`);
  const nasmExe = path.join(extractedDir, "nasm.exe");
  if (!fs.existsSync(nasmExe)) {
    const downloadUrl = `https://www.nasm.us/pub/nasm/releasebuilds/${nasmVersion}/win64/${archiveName}`;
    console.log(`Downloading portable NASM from ${downloadUrl}...`);
    await downloadFile(downloadUrl, archivePath);
    fs.rmSync(extractedDir, { recursive: true, force: true });
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${cacheRoot.replace(/'/g, "''")}' -Force`,
    ], appRoot);
  }
  return extractedDir;
}

async function buildEnvWithNativeTools() {
  if (buildArch !== "ia32") {
    return process.env;
  }
  const cmakeBinDir = await resolvePortableCmakeBinDir();
  const nasmBinDir = await resolvePortableNasmBinDir();
  return {
    ...process.env,
    PATH: `${cmakeBinDir}${path.delimiter}${nasmBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

async function prepareBundledNodeRuntime() {
  const runtimeDir = path.join(appRoot, "dist-runtime");
  const nodeDestination = path.join(runtimeDir, "node.exe");
  const nodeSource = buildArch === "ia32"
    ? await resolveIa32NodeRuntime()
    : process.execPath;

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(nodeSource, nodeDestination);

  assertPeMachine(nodeDestination, buildArch === "ia32" ? 0x14c : 0x8664, "bundled Node runtime");

  console.log(`Bundled ${buildArch} Node runtime at ${path.relative(appRoot, nodeDestination)}`);
}

async function buildRustPocRelease() {
  const pocDir = path.join(repoRoot, "aether-link-poc");
  const rustTarget = buildArch === "ia32" ? "i686-pc-windows-msvc" : undefined;
  const pocExe = rustTarget
    ? path.join(pocDir, "target", rustTarget, "release", "wonremote-poc.exe")
    : path.join(pocDir, "target", "release", "wonremote-poc.exe");
  const distPocDir = path.join(appRoot, "dist-poc");
  const distPocExe = path.join(distPocDir, "wonremote-poc.exe");

  console.log(`Building ${buildArch} Rust PoC release binary with cargo build --release${rustTarget ? ` --target ${rustTarget}` : ""}...`);
  run(
    "cargo",
    rustTarget ? ["build", "--release", "--target", rustTarget] : ["build", "--release"],
    pocDir,
    await buildEnvWithNativeTools(),
  );

  if (!fs.existsSync(pocExe)) {
    throw new Error(`Rust PoC release binary was not produced: ${pocExe}`);
  }
  fs.mkdirSync(distPocDir, { recursive: true });
  fs.copyFileSync(pocExe, distPocExe);
  assertPeMachine(distPocExe, buildArch === "ia32" ? 0x14c : 0x8664, "bundled Rust PoC");
}

async function build() {
  fs.mkdirSync(path.join(appRoot, "dist-server"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "dist-agent"), { recursive: true });
  await prepareBundledNodeRuntime();
  await buildRustPocRelease();

  console.log("Building API Server to dist-server/index.mjs...");
  await esbuild.build({
    entryPoints: ["src/server/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: "dist-server/index.mjs",
    sourcemap: true,
    absWorkingDir: appRoot,
    external: ["fsevents"],
    banner: {
      js: nodeEsmRequireBanner,
    },
  });

  console.log("Building Agent to dist-agent/index.mjs...");
  await esbuild.build({
    entryPoints: ["src/agent/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: "dist-agent/index.mjs",
    sourcemap: true,
    absWorkingDir: appRoot,
    external: ["fsevents", "node-datachannel", "node-datachannel/polyfill"],
    banner: {
      js: nodeEsmRequireBanner,
    },
  });

  console.log("Backend bundling completed successfully!");
}

build().catch((err) => {
  console.error("Backend build failed:", err);
  process.exit(1);
});
