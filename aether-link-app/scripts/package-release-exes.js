import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(appRoot, "src-tauri", "target");
const outputDir = path.join(appRoot, "release-exe");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const requiredResourceDirs = ["server", "agent", "runtime", "bin", "node_modules"];
const x86WebRtcRuntimeMarker = "wonremote-webrtc-runtime:werift";

export function assertReleaseVersionConsistency() {
  const cargoToml = fs.readFileSync(path.join(appRoot, "src-tauri", "Cargo.toml"), "utf8");
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const appVersionSource = fs.readFileSync(path.join(appRoot, "src", "domain", "appVersion.ts"), "utf8");
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const appVersion = appVersionSource.match(/WONREMOTE_APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const versions = {
    "package.json": packageJson.version,
    "src-tauri/Cargo.toml": cargoVersion,
    "src-tauri/tauri.conf.json": tauriConfig.version,
    "src/domain/appVersion.ts": appVersion,
  };
  const distinctVersions = new Set(Object.values(versions));
  if (distinctVersions.size !== 1 || [...distinctVersions].includes(undefined)) {
    throw new Error(`Release version mismatch: ${Object.entries(versions).map(([file, version]) => `${file}=${version ?? "missing"}`).join(", ")}`);
  }
}

const TARGET_ARCHITECTURES = [
  {
    key: "x64",
    buildArch: "x64",
    rustTarget: null,
    viewerConfig: null,
    agentConfig: "src-tauri/tauri.agent.conf.json",
    installerArch: "x64",
  },
  {
    key: "x86",
    buildArch: "ia32",
    rustTarget: "i686-pc-windows-msvc",
    viewerConfig: "src-tauri/tauri.x86.conf.json",
    agentConfig: "src-tauri/tauri.agent.x86.conf.json",
    installerArch: "x86",
  },
];

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} is missing: ${targetPath}`);
  }
}

function runShell(command, env = process.env) {
  const shell = process.platform === "win32" ? "cmd.exe" : "sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];
  execFileSync(shell, args, {
    cwd: appRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
}

function releaseTargetFor(target) {
  return target.rustTarget
    ? path.join(releaseRoot, target.rustTarget, "release")
    : path.join(releaseRoot, "release");
}

function buildEnvFor(target, extra = {}) {
  return {
    ...process.env,
    ...extra,
    VITE_WONREMOTE_BUILD_ARCH: target.buildArch,
    WONREMOTE_BUILD_ARCH: target.buildArch,
  };
}

function buildTauriCommand(target, configPath) {
  return [
    "npx tauri build",
    target.rustTarget ? `--target ${target.rustTarget}` : "",
    configPath ? `--config ${configPath}` : "",
  ].filter(Boolean).join(" ");
}

function cleanTauriResourceOutput(target) {
  const targetRelease = releaseTargetFor(target);
  for (const directory of requiredResourceDirs) {
    fs.rmSync(path.join(targetRelease, directory), { recursive: true, force: true });
  }
}

function buildViewerInstaller(target) {
  console.log(`Building ${target.key} Viewer NSIS installer...`);
  cleanTauriResourceOutput(target);
  runShell(buildTauriCommand(target, target.viewerConfig), buildEnvFor(target, {
    WONREMOTE_BUILD_STAGE: "full",
  }));
}

function buildAgentDefaultInstaller(target) {
  console.log(`Building ${target.key} Agent-default NSIS installer...`);
  cleanTauriResourceOutput(target);
  runShell(buildTauriCommand(target, target.agentConfig), buildEnvFor(target, {
    WONREMOTE_BUILD_STAGE: "reuse",
    WONREMOTE_DEFAULT_APP_MODE: "agent",
  }));
}

function escapeNsisString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '$\\"');
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
  throw new Error("makensis.exe is missing. Build with Tauri once or set WONREMOTE_MAKENSIS_PATH.");
}

function createUniversalProductInstaller(packages, defaultMode) {
  const outputName = defaultMode === "agent" ? "WonRemote-Agent-Setup.exe" : "WonRemote-Viewer-Setup.exe";
  const outputPath = path.join(outputDir, outputName);
  const scriptPath = path.join(outputDir, `WonRemote-${defaultMode}-Setup-universal.nsi`);
  const script = createUniversalProductInstallerScript(packages, defaultMode, outputPath);

  fs.writeFileSync(scriptPath, script, "utf8");
  fs.rmSync(outputPath, { force: true });
  execFileSync(resolveMakensisPath(), [scriptPath], {
    cwd: appRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  fs.rmSync(scriptPath, { force: true });
  ensureExists(outputPath, `universal WonRemote ${defaultMode} installer wrapper`);
}

export function createUniversalProductInstallerScript(packages, defaultMode, outputPath) {
  const installerPathKey = defaultMode === "agent" ? "agentInstallerPath" : "viewerInstallerPath";
  const productFilename = defaultMode === "agent" ? "agent" : "viewer";
  const directLaunch = defaultMode === "agent"
    ? `Exec '"$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" --agent'`
    : `Exec '"$LOCALAPPDATA\\WonRemote\\Viewer\\wonremote-viewer.exe"'`;
  const companionRestart = defaultMode === "viewer"
    ? `IfFileExists "$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" 0 +2
  Exec '"$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" --agent'`
    : "";
  const script = `!include LogicLib.nsh
!include x64.nsh
Unicode true
Name "WonRemote ${defaultMode === "agent" ? "Agent" : "Viewer"}"
OutFile "${escapeNsisString(outputPath)}"
RequestExecutionLevel user
Page instfiles

Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=${productFilename}-x64.exe "${escapeNsisString(packages.x64[installerPathKey])}"
  File /oname=${productFilename}-x86.exe "${escapeNsisString(packages.x86[installerPathKey])}"

  DetailPrint "Installing WonRemote ${defaultMode === "agent" ? "Agent" : "Viewer"}..."
  \${If} \${RunningX64}
    ExecWait '"$PLUGINSDIR\\${productFilename}-x64.exe" /S' $0
  \${Else}
    ExecWait '"$PLUGINSDIR\\${productFilename}-x86.exe" /S' $0
  \${EndIf}
  \${If} $0 != 0
    SetErrorLevel $0
    Abort "WonRemote ${defaultMode} installer failed."
  \${EndIf}
  ${companionRestart}
  IfSilent +2 0
  ${directLaunch}
SectionEnd
`;
  return script;
}

function verifyTargetAgentRuntime(target, sourceRoot) {
  const agentBundlePath = path.join(sourceRoot, "agent", "index.mjs");
  ensureExists(agentBundlePath, `${target.key} Agent bundle`);
  const source = fs.readFileSync(agentBundlePath, "utf8");
  if (target.key === "x86" && !source.includes(x86WebRtcRuntimeMarker)) {
    throw new Error("x86 release payload is missing the bundled werift runtime marker.");
  }
  if (target.key === "x86" && /import\(["']werift["']\)/.test(source)) {
    throw new Error("x86 release payload contains an unresolved werift import.");
  }
}

function packageTarget(target) {
  buildViewerInstaller(target);

  const targetRelease = releaseTargetFor(target);
  const installerDir = path.join(targetRelease, "bundle", "nsis");
  const expectedInstaller = `WonRemote Viewer_${packageJson.version}_${target.installerArch}-setup.exe`;
  const expectedAgentInstaller = `WonRemote Agent_${packageJson.version}_${target.installerArch}-setup.exe`;
  const expectedInstallerPath = path.join(installerDir, expectedInstaller);
  const expectedAgentInstallerPath = path.join(installerDir, expectedAgentInstaller);
  ensureExists(expectedInstallerPath, `${target.key} WonRemote Viewer NSIS installer`);

  buildAgentDefaultInstaller(target);
  ensureExists(expectedAgentInstallerPath, `${target.key} Agent-default WonRemote Agent NSIS installer`);
  verifyTargetAgentRuntime(target, targetRelease);
  return {
    agentInstallerPath: expectedAgentInstallerPath,
    viewerInstallerPath: expectedInstallerPath,
  };
}

function existingTargetPackages(target) {
  const installerDir = path.join(releaseTargetFor(target), "bundle", "nsis");
  const viewerInstallerPath = path.join(
    installerDir,
    `WonRemote Viewer_${packageJson.version}_${target.installerArch}-setup.exe`,
  );
  const agentInstallerPath = path.join(
    installerDir,
    `WonRemote Agent_${packageJson.version}_${target.installerArch}-setup.exe`,
  );
  ensureExists(viewerInstallerPath, `${target.key} existing Viewer installer`);
  ensureExists(agentInstallerPath, `${target.key} existing Agent installer`);
  return { agentInstallerPath, viewerInstallerPath };
}

function resetReleaseOutput() {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
}

function assembleUniversalInstallers(packages) {
  createUniversalProductInstaller(packages, "viewer");
  createUniversalProductInstaller(packages, "agent");

  const expectedOutputs = ["WonRemote-Agent-Setup.exe", "WonRemote-Viewer-Setup.exe"];
  const actualOutputs = fs.readdirSync(outputDir).filter((name) => /\.exe$/i.test(name)).sort();
  if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) {
    throw new Error(`Release output must contain exactly two universal product installers; found: ${actualOutputs.join(", ")}`);
  }
  console.log(`Two universal WonRemote product installers created at ${outputDir}`);
}

function main() {
  assertReleaseVersionConsistency();
  resetReleaseOutput();

  const packages = {};
  for (const target of TARGET_ARCHITECTURES) {
    packages[target.key] = packageTarget(target);
  }
  assembleUniversalInstallers(packages);
}

function assembleExistingInstallers() {
  assertReleaseVersionConsistency();
  const packages = {};
  for (const target of TARGET_ARCHITECTURES) {
    packages[target.key] = existingTargetPackages(target);
  }
  resetReleaseOutput();
  assembleUniversalInstallers(packages);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--assemble-only")) {
    assembleExistingInstallers();
  } else {
    main();
  }
}
