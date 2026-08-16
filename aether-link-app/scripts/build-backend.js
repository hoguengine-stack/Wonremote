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

function readPeImports(filePath) {
  const bytes = fs.readFileSync(filePath);
  const peOffset = bytes.readUInt32LE(0x3c);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96);
  const importDirectoryRva = bytes.readUInt32LE(dataDirectoryOffset + 8);
  if (!importDirectoryRva) {
    return [];
  }

  const sectionHeaderOffset = optionalHeaderOffset + optionalHeaderSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionHeaderOffset + index * 40;
    sections.push({
      virtualAddress: bytes.readUInt32LE(offset + 12),
      virtualSize: bytes.readUInt32LE(offset + 8),
      rawAddress: bytes.readUInt32LE(offset + 20),
      rawSize: bytes.readUInt32LE(offset + 16),
    });
  }

  function rvaToOffset(rva) {
    const section = sections.find((candidate) => {
      const size = Math.max(candidate.virtualSize, candidate.rawSize);
      return rva >= candidate.virtualAddress && rva < candidate.virtualAddress + size;
    });
    if (!section) {
      throw new Error(`Cannot map PE RVA 0x${rva.toString(16)} in ${filePath}`);
    }
    return section.rawAddress + (rva - section.virtualAddress);
  }

  const imports = [];
  let descriptorOffset = rvaToOffset(importDirectoryRva);
  while (descriptorOffset + 20 <= bytes.length) {
    const originalFirstThunk = bytes.readUInt32LE(descriptorOffset);
    const timeDateStamp = bytes.readUInt32LE(descriptorOffset + 4);
    const forwarderChain = bytes.readUInt32LE(descriptorOffset + 8);
    const nameRva = bytes.readUInt32LE(descriptorOffset + 12);
    const firstThunk = bytes.readUInt32LE(descriptorOffset + 16);
    if (!originalFirstThunk && !timeDateStamp && !forwarderChain && !nameRva && !firstThunk) {
      break;
    }

    const nameOffset = rvaToOffset(nameRva);
    let nameEnd = nameOffset;
    while (nameEnd < bytes.length && bytes[nameEnd] !== 0) {
      nameEnd += 1;
    }
    imports.push(bytes.toString("ascii", nameOffset, nameEnd));
    descriptorOffset += 20;
  }
  return imports;
}

function resolveVcRuntimeDll(targetArch) {
  const overridePath = process.env.WONREMOTE_VCRUNTIME140_PATH;
  if (overridePath) {
    return path.resolve(overridePath);
  }

  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const redistRoot = path.join(programFilesX86, "Microsoft Visual Studio", "2022", "BuildTools", "VC", "Redist", "MSVC");
  const redistArch = targetArch === "ia32" ? "x86" : "x64";
  if (fs.existsSync(redistRoot)) {
    const candidates = fs.readdirSync(redistRoot)
      .map((version) => path.join(redistRoot, version, redistArch, "Microsoft.VC143.CRT", "vcruntime140.dll"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
      .reverse();
    if (candidates[0]) {
      return candidates[0];
    }
  }

  const systemFallback = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    targetArch === "ia32" ? "SysWOW64" : "System32",
    "vcruntime140.dll",
  );
  if (fs.existsSync(systemFallback)) {
    return systemFallback;
  }

  throw new Error(`vcruntime140.dll was not found for ${targetArch}. Install Visual Studio Build Tools or set WONREMOTE_VCRUNTIME140_PATH.`);
}

function bundlePocRuntimeDlls(pocExe, distPocDir) {
  const imports = readPeImports(pocExe).map((name) => name.toLowerCase());
  const runtimeSource = resolveVcRuntimeDll(buildArch);
  const runtimeDestination = path.join(distPocDir, "vcruntime140.dll");
  fs.copyFileSync(runtimeSource, runtimeDestination);
  assertPeMachine(runtimeDestination, buildArch === "ia32" ? 0x14c : 0x8664, "bundled VC runtime");
  const importReason = imports.includes("vcruntime140.dll") ? "required by PoC import table" : "app-local compatibility";
  console.log(`Bundled ${buildArch} VC runtime at ${path.relative(appRoot, runtimeDestination)} (${importReason})`);
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

function prepareNativeNodeDatachannelRuntime() {
  const nativeDir = path.join(appRoot, "dist-native", "node-datachannel");
  fs.rmSync(nativeDir, { recursive: true, force: true });
  fs.mkdirSync(nativeDir, { recursive: true });

  if (buildArch === "ia32") {
    fs.writeFileSync(
      path.join(nativeDir, "package.json"),
      JSON.stringify(
        {
          name: "node-datachannel",
          version: "0.0.0-wonremote-ia32-unused",
          private: true,
          description: "WonRemote x86 uses the pure-JS werift runtime bundled in agent/index.mjs.",
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`Created ${buildArch} native-runtime marker at ${path.relative(appRoot, nativeDir)}`);
    return;
  }

  const sourceDir = path.join(appRoot, "node_modules", "node-datachannel");
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`node-datachannel dependency is missing: ${sourceDir}`);
  }
  fs.cpSync(sourceDir, nativeDir, { recursive: true });
  assertNativeAddonMachines(nativeDir, 0x8664, "node-datachannel");
  console.log(`Bundled ${buildArch} node-datachannel runtime at ${path.relative(appRoot, nativeDir)}`);
}

function assertNativeAddonMachines(rootDir, expectedMachine, label) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        assertPeMachine(fullPath, expectedMachine, `${label} native addon ${path.relative(rootDir, fullPath)}`);
      }
    }
  }
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
  bundlePocRuntimeDlls(distPocExe, distPocDir);
}

async function build() {
  fs.mkdirSync(path.join(appRoot, "dist-server"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "dist-agent"), { recursive: true });
  await prepareBundledNodeRuntime();
  await buildRustPocRelease();
  prepareNativeNodeDatachannelRuntime();

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
  const agentBuild = await esbuild.build({
    entryPoints: ["src/agent/index.ts"],
    bundle: true,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: "dist-agent/index.mjs",
    sourcemap: true,
    absWorkingDir: appRoot,
    external: [
      "fsevents",
      "node-datachannel",
      "node-datachannel/polyfill",
      ...(buildArch === "ia32" ? [] : ["werift"]),
    ],
    banner: {
      js: nodeEsmRequireBanner,
    },
  });
  assertAgentWebRtcBundle(agentBuild.metafile);
  if (buildArch === "ia32") {
    runBundledX86AgentWebRtcSmoke();
  }

  console.log("Backend bundling completed successfully!");
}

export function runBundledX86AgentWebRtcSmoke({
  execFile = execFileSync,
  ensureFile = ensureExists,
  rootDir = appRoot,
} = {}) {
  const nodePath = path.join(rootDir, "dist-runtime", "node.exe");
  const agentPath = path.join(rootDir, "dist-agent", "index.mjs");
  const expectedOutput = "Agent runtime smoke passed: arch=ia32, webrtc=werift";

  ensureFile(nodePath, "bundled x86 Node runtime for WebRTC smoke");
  ensureFile(agentPath, "bundled x86 Agent runtime for WebRTC smoke");
  console.log("Running bundled x86 Agent WebRTC runtime smoke...");
  const output = execFile(nodePath, [agentPath, "--runtime-smoke"], {
    cwd: path.dirname(agentPath),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!String(output).includes(expectedOutput)) {
    throw new Error(
      `Bundled x86 Agent WebRTC smoke did not confirm werift runtime. Expected output: ${expectedOutput}`,
    );
  }
}

function assertAgentWebRtcBundle(metafile) {
  const inputs = Object.keys(metafile.inputs).map((input) => input.replace(/\\/g, "/"));
  const includesWerift = inputs.some((input) => input.includes("/node_modules/werift/") || input.startsWith("node_modules/werift/"));
  if (buildArch === "ia32" && !includesWerift) {
    throw new Error("x86 Agent bundle is missing the pure-JS werift runtime.");
  }
  if (buildArch !== "ia32" && includesWerift) {
    throw new Error("x64 Agent bundle must keep werift external and use node-datachannel/polyfill.");
  }
  console.log(
    buildArch === "ia32"
      ? "Verified bundled x86 werift runtime in dist-agent/index.mjs."
      : "Verified x64 Agent bundle keeps the x86 werift runtime external.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((err) => {
    console.error("Backend build failed:", err);
    process.exit(1);
  });
}
