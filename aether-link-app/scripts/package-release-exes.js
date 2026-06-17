import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(appRoot, "src-tauri", "target");
const outputDir = path.join(appRoot, "release-exe");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const requiredResourceDirs = ["server", "agent", "runtime", "bin", "node_modules"];

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

function buildViewerInstaller(target) {
  console.log(`Building ${target.key} Viewer NSIS installer...`);
  runShell(buildTauriCommand(target, target.viewerConfig), buildEnvFor(target));
}

function buildAgentDefaultInstaller(target) {
  console.log(`Building ${target.key} Agent-default NSIS installer...`);
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
  createZip(target.stablePortableZipName, [
    "WonRemote Viewer.exe",
    "WonRemote Agent.exe",
    "README.txt",
    ...requiredResourceDirs,
  ], target.stageDir);
}

function createAgentPortableZip(target) {
  createZip(target.stableAgentZipName, [
    "WonRemote Agent.exe",
    "README.txt",
    ...requiredResourceDirs,
  ], target.stageDir);
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

function copyPortablePayload(target, sourceRoot) {
  const viewerSource = path.join(sourceRoot, "wonremote-viewer.exe");
  ensureExists(viewerSource, `${target.key} Tauri viewer executable`);
  fs.mkdirSync(target.stageDir, { recursive: true });
  fs.copyFileSync(viewerSource, path.join(target.stageDir, "WonRemote Viewer.exe"));
  fs.copyFileSync(viewerSource, path.join(target.stageDir, "WonRemote Agent.exe"));
  for (const directory of requiredResourceDirs) {
    copyDirectory(sourceRoot, target.stageDir, directory);
  }
  writeReadme(target.stageDir);
}

function packageTarget(target) {
  buildViewerInstaller(target);

  const targetRelease = releaseTargetFor(target);
  copyPortablePayload(target, targetRelease);

  const installerDir = path.join(targetRelease, "bundle", "nsis");
  const expectedInstaller = `WonRemote Viewer_${packageJson.version}_${target.installerArch}-setup.exe`;
  const expectedAgentInstaller = `WonRemote Agent_${packageJson.version}_${target.installerArch}-setup.exe`;
  const expectedInstallerPath = path.join(installerDir, expectedInstaller);
  const expectedAgentInstallerPath = path.join(installerDir, expectedAgentInstaller);
  ensureExists(expectedInstallerPath, `${target.key} WonRemote Viewer NSIS installer`);
  copyInstaller(expectedInstallerPath, expectedInstaller);
  copyInstaller(expectedInstallerPath, target.stableInstallerName);

  buildAgentDefaultInstaller(target);

  ensureExists(expectedAgentInstallerPath, `${target.key} Agent-default WonRemote NSIS installer`);
  copyInstaller(expectedAgentInstallerPath, expectedAgentInstaller);
  copyInstaller(expectedAgentInstallerPath, target.stableAgentInstallerName);
  createCombinedInstaller(expectedInstallerPath, expectedAgentInstallerPath, target);

  createPortableZip(target);
  createAgentPortableZip(target);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const target of TARGET_ARCHITECTURES) {
  packageTarget(target);
}

console.log(`Portable EXE packages created at ${outputDir}`);
