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
    stageDir: outputDir,
    stableInstallerName: "WonRemote-Viewer-Setup.exe",
    stableAgentInstallerName: "WonRemote-Agent-Setup.exe",
  },
  {
    key: "x86",
    buildArch: "ia32",
    rustTarget: "i686-pc-windows-msvc",
    viewerConfig: "src-tauri/tauri.x86.conf.json",
    agentConfig: "src-tauri/tauri.agent.x86.conf.json",
    installerArch: "x86",
    stageDir: path.join(outputDir, "x86"),
    stableInstallerName: "WonRemote-Viewer-Setup-x86.exe",
    stableAgentInstallerName: "WonRemote-Agent-Setup-x86.exe",
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
  runShell(buildTauriCommand(target, target.viewerConfig), buildEnvFor(target));
}

function buildAgentDefaultInstaller(target) {
  console.log(`Building ${target.key} Agent-default NSIS installer...`);
  cleanTauriResourceOutput(target);
  runShell(buildTauriCommand(target, target.agentConfig), buildEnvFor(target, {
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

function x64OnlyNsisGuard(target) {
  if (target.key !== "x64") {
    return "";
  }
  return `  \${IfNot} \${RunningX64}
    MessageBox MB_ICONSTOP "WonRemote requires 64-bit Windows. This installer cannot run on 32-bit Windows."
    Abort
  \${EndIf}

`;
}

function createProductInstaller(viewerInstallerPath, agentInstallerPath, target, defaultMode) {
  const outputName = defaultMode === "agent" ? target.stableAgentInstallerName : target.stableInstallerName;
  const outputPath = path.join(outputDir, outputName);
  const scriptPath = path.join(outputDir, `WonRemote-${defaultMode}-Setup-${target.key}.nsi`);
  const script = `!include LogicLib.nsh
!include x64.nsh
Unicode true
Name "WonRemote ${defaultMode === "agent" ? "Agent" : "Viewer"}"
OutFile "${escapeNsisString(outputPath)}"
RequestExecutionLevel user
Page instfiles

Section "Install"
${x64OnlyNsisGuard(target)}  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=viewer-installer.exe "${escapeNsisString(viewerInstallerPath)}"
  File /oname=agent-installer.exe "${escapeNsisString(agentInstallerPath)}"

  ReadEnvStr $R0 "WONREMOTE_RESTART_MODE"
  StrCpy $R1 "1"
  \${If} $R0 != "viewer"
  \${AndIf} $R0 != "agent"
    StrCpy $R0 "${defaultMode}"
    StrCpy $R1 "0"
  \${EndIf}
  \${If} $R0 == "agent"
    DetailPrint "Installing WonRemote Agent..."
    ExecWait '"$PLUGINSDIR\\agent-installer.exe" /S' $0
  \${Else}
    DetailPrint "Installing WonRemote Viewer..."
    ExecWait '"$PLUGINSDIR\\viewer-installer.exe" /S' $0
  \${EndIf}
  \${If} $0 != 0
    SetErrorLevel $0
    Abort "WonRemote $R0 installer failed."
  \${EndIf}
  \${If} $R1 == "1"
    \${If} $R0 == "agent"
      Exec '"$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" --agent'
    \${Else}
      Exec '"$LOCALAPPDATA\\WonRemote\\Viewer\\wonremote-viewer.exe"'
      IfFileExists "$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" 0 +2
      Exec '"$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" --agent'
    \${EndIf}
  \${EndIf}
SectionEnd
`;

  fs.writeFileSync(scriptPath, script, "utf8");
  fs.rmSync(outputPath, { force: true });
  execFileSync(resolveMakensisPath(), [scriptPath], {
    cwd: appRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  fs.rmSync(scriptPath, { force: true });
  ensureExists(outputPath, `${target.key} WonRemote ${defaultMode} installer wrapper`);
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
  createProductInstaller(expectedInstallerPath, expectedAgentInstallerPath, target, "viewer");
  createProductInstaller(expectedInstallerPath, expectedAgentInstallerPath, target, "agent");
}

function main() {
  assertReleaseVersionConsistency();
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  for (const target of TARGET_ARCHITECTURES) {
    packageTarget(target);
  }

  const expectedOutputs = TARGET_ARCHITECTURES.flatMap((target) => [
    target.stableInstallerName,
    target.stableAgentInstallerName,
  ]).sort();
  const actualOutputs = fs.readdirSync(outputDir).filter((name) => /\.exe$/i.test(name)).sort();
  if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) {
    throw new Error(`Release output must contain exactly four product installers; found: ${actualOutputs.join(", ")}`);
  }
  console.log(`Four WonRemote product installers created at ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
