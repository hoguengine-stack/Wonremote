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
const portableMarkerName = "wonremote-portable.json";

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
    stableFullInstallerName: "WonRemote-Viewer-Agent-Setup.exe",
    stablePortableZipName: "WonRemote-Viewer-Agent-Portable.zip",
    stableAgentZipName: "WonRemote-Agent-Portable.zip",
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
    stableFullInstallerName: "WonRemote-Viewer-Agent-Setup-x86.exe",
    stablePortableZipName: "WonRemote-Viewer-Agent-Portable-x86.zip",
    stableAgentZipName: "WonRemote-Agent-Portable-x86.zip",
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

function copyDirectory(sourceRoot, destinationRoot, name) {
  const source = path.join(sourceRoot, name);
  const destination = path.join(destinationRoot, name);
  ensureExists(source, `${name} resource directory`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function writeReadme(baseDir) {
  const content = `# WonRemote Portable EXE Package

Run these files from this folder:

- WonRemote Viewer.exe: opens the Viewer UI.
- WonRemote Agent.exe: starts Agent tray/background mode. On first run, it opens the registration screen.

Do not move the EXE files away from the server/, agent/, runtime/, and bin/ folders.
`;
  fs.writeFileSync(path.join(baseDir, "README.txt"), content, "utf8");
}

function quotePowerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function createZip(zipName, entries, baseDir) {
  const zipPath = path.join(outputDir, zipName);
  const portableEntries = entries.map((entry) => path.join(baseDir, entry));
  const literalPaths = portableEntries.map(quotePowerShellLiteral).join(", ");
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `Compress-Archive -LiteralPath @(${literalPaths}) -DestinationPath ${quotePowerShellLiteral(zipPath)} -CompressionLevel Optimal -Force`,
  ].join("; ");

  fs.rmSync(zipPath, { force: true });
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    stdio: "pipe",
    windowsHide: true,
  });
}

function createPortableZip(target) {
  withPortableMarker(target, "portable", () => {
    createZip(target.stablePortableZipName, [
      "WonRemote Viewer.exe",
      "WonRemote Agent.exe",
      "README.txt",
      portableMarkerName,
      ...requiredResourceDirs,
    ], target.stageDir);
  });
}

function createAgentPortableZip(target) {
  withPortableMarker(target, "portable-agent", () => {
    createZip(target.stableAgentZipName, [
      "WonRemote Agent.exe",
      "README.txt",
      portableMarkerName,
      ...requiredResourceDirs,
    ], target.stageDir);
  });
}

export function withPortableMarker(target, packageKind, createArchive) {
  const markerPath = path.join(target.stageDir, portableMarkerName);
  const marker = {
    schemaVersion: 1,
    packageKind,
    version: packageJson.version,
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  try {
    createArchive();
  } finally {
    fs.rmSync(markerPath, { force: true });
  }
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

function createCombinedInstaller(viewerInstallerPath, agentInstallerPath, target) {
  const outputPath = path.join(outputDir, target.stableFullInstallerName);
  const scriptPath = path.join(outputDir, `WonRemote-Viewer-Agent-Setup-${target.key}.nsi`);
  const bridgeScriptPath = path.join(appRoot, "scripts", "portable-installer-bridge.ps1");
  const portableZipPath = path.join(outputDir, target.stablePortableZipName);
  const agentPortableZipPath = path.join(outputDir, target.stableAgentZipName);
  ensureExists(bridgeScriptPath, "legacy portable installer bridge");
  ensureExists(portableZipPath, `${target.key} combined portable ZIP`);
  ensureExists(agentPortableZipPath, `${target.key} Agent portable ZIP`);
  const script = `!include LogicLib.nsh
!include x64.nsh
Unicode true
Name "WonRemote Viewer + Agent"
OutFile "${escapeNsisString(outputPath)}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\\WonRemote"
Page instfiles

Section "Install"
${x64OnlyNsisGuard(target)}  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=${target.stableInstallerName} "${escapeNsisString(viewerInstallerPath)}"
  File /oname=${target.stableAgentInstallerName} "${escapeNsisString(agentInstallerPath)}"
  File /oname=portable-installer-bridge.ps1 "${escapeNsisString(bridgeScriptPath)}"
  File /oname=${target.stablePortableZipName} "${escapeNsisString(portableZipPath)}"
  File /oname=${target.stableAgentZipName} "${escapeNsisString(agentPortableZipPath)}"

  ReadEnvStr $R0 "WONREMOTE_APP_DIR"
  \${If} $R0 != ""
    ReadEnvStr $R1 "WONREMOTE_RESTART_MODE"
    \${If} $R1 != "viewer"
    \${AndIf} $R1 != "agent"
      StrCpy $R1 "auto"
    \${EndIf}
    DetailPrint "Checking for a legacy WonRemote portable package..."
    ExecWait '\"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"$PLUGINSDIR\\portable-installer-bridge.ps1\" -PortableRoot \"$R0\" -CombinedArchivePath \"$PLUGINSDIR\\${target.stablePortableZipName}\" -AgentArchivePath \"$PLUGINSDIR\\${target.stableAgentZipName}\" -ExpectedVersion \"${packageJson.version}\" -RestartMode \"$R1\"' $R4
    \${If} $R4 == 0
      Goto install_done
    \${ElseIf} $R4 == 20
      Goto install_done
    \${ElseIf} $R4 != 10
      SetErrorLevel $R4
      Abort "WonRemote portable update failed and was rolled back."
    \${EndIf}
  \${EndIf}

normal_install:
  DetailPrint "Installing WonRemote Viewer..."
  ExecWait '"$PLUGINSDIR\\${target.stableInstallerName}" /S' $0
  \${If} $0 != 0
    SetErrorLevel $0
    Abort "WonRemote Viewer installer failed."
  \${EndIf}

  DetailPrint "Installing WonRemote Agent..."
  ExecWait '"$PLUGINSDIR\\${target.stableAgentInstallerName}" /S' $1
  \${If} $1 != 0
    SetErrorLevel $1
    Abort "WonRemote Agent installer failed."
  \${EndIf}

install_done:
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
  ensureExists(outputPath, `combined ${target.key} WonRemote viewer and agent installer`);
}

function copyInstaller(sourcePath, targetName) {
  fs.copyFileSync(sourcePath, path.join(outputDir, targetName));
}

function copyViewerPortablePayload(target, sourceRoot) {
  const viewerSource = path.join(sourceRoot, "wonremote-viewer.exe");
  ensureExists(viewerSource, `${target.key} Tauri viewer executable`);
  verifyTargetAgentRuntime(target, sourceRoot);
  fs.mkdirSync(target.stageDir, { recursive: true });
  fs.copyFileSync(viewerSource, path.join(target.stageDir, "WonRemote Viewer.exe"));
  for (const directory of requiredResourceDirs) {
    copyDirectory(sourceRoot, target.stageDir, directory);
  }
  writeReadme(target.stageDir);
}

function copyAgentPortableExecutable(target, sourceRoot) {
  const agentSource = path.join(sourceRoot, "wonremote-viewer.exe");
  ensureExists(agentSource, `${target.key} Tauri Agent executable`);
  fs.copyFileSync(agentSource, path.join(target.stageDir, "WonRemote Agent.exe"));
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
  copyViewerPortablePayload(target, targetRelease);

  const installerDir = path.join(targetRelease, "bundle", "nsis");
  const expectedInstaller = `WonRemote Viewer_${packageJson.version}_${target.installerArch}-setup.exe`;
  const expectedAgentInstaller = `WonRemote Agent_${packageJson.version}_${target.installerArch}-setup.exe`;
  const expectedInstallerPath = path.join(installerDir, expectedInstaller);
  const expectedAgentInstallerPath = path.join(installerDir, expectedAgentInstaller);
  ensureExists(expectedInstallerPath, `${target.key} WonRemote Viewer NSIS installer`);
  copyInstaller(expectedInstallerPath, expectedInstaller);
  copyInstaller(expectedInstallerPath, target.stableInstallerName);

  buildAgentDefaultInstaller(target);
  copyAgentPortableExecutable(target, targetRelease);

  ensureExists(expectedAgentInstallerPath, `${target.key} Agent-default WonRemote NSIS installer`);
  copyInstaller(expectedAgentInstallerPath, expectedAgentInstaller);
  copyInstaller(expectedAgentInstallerPath, target.stableAgentInstallerName);

  const installedPayloadMarker = path.join(targetRelease, portableMarkerName);
  if (fs.existsSync(installedPayloadMarker)) {
    throw new Error(`Portable marker must not be present in installed ${target.key} resources: ${installedPayloadMarker}`);
  }
  createPortableZip(target);
  createAgentPortableZip(target);
  createCombinedInstaller(expectedInstallerPath, expectedAgentInstallerPath, target);
  if (fs.existsSync(path.join(target.stageDir, portableMarkerName))) {
    throw new Error(`Portable marker cleanup failed for ${target.key}.`);
  }
}

function main() {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  for (const target of TARGET_ARCHITECTURES) {
    packageTarget(target);
  }

  console.log(`Portable EXE packages created at ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
