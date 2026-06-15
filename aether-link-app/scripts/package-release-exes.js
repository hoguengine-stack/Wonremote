import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseTarget = path.join(appRoot, "src-tauri", "target", "release");
const outputDir = path.join(appRoot, "release-exe");
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const stableInstallerName = "WonRemote-Viewer-Setup.exe";
const stablePortableZipName = "WonRemote-Viewer-Agent-Portable.zip";
const stableAgentZipName = "WonRemote-Agent-Portable.zip";

const viewerSource = path.join(releaseTarget, "wonremote-viewer.exe");
const requiredResourceDirs = ["server", "agent", "runtime", "bin"];

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} is missing: ${targetPath}`);
  }
}

function copyDirectory(name) {
  const source = path.join(releaseTarget, name);
  const destination = path.join(outputDir, name);
  ensureExists(source, `${name} resource directory`);
  fs.cpSync(source, destination, { recursive: true });
}

function writeReadme() {
  const content = `# WonRemote Portable EXE Package

Run these files from this folder:

- WonRemote Viewer.exe: opens the Viewer UI.
- WonRemote Agent.exe: starts Agent tray/background mode. On first run, it opens the registration screen.

Do not move the EXE files away from the server/, agent/, runtime/, and bin/ folders.
`;
  fs.writeFileSync(path.join(outputDir, "README.txt"), content, "utf8");
}

function quotePowerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function createZip(zipName, entries) {
  const zipPath = path.join(outputDir, zipName);
  const portableEntries = entries.map((entry) => path.join(outputDir, entry));
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

function createPortableZip() {
  createZip(stablePortableZipName, [
    "WonRemote Viewer.exe",
    "WonRemote Agent.exe",
    "README.txt",
    ...requiredResourceDirs,
  ]);
}

function createAgentPortableZip() {
  createZip(stableAgentZipName, [
    "WonRemote Agent.exe",
    "README.txt",
    ...requiredResourceDirs,
  ]);
}

ensureExists(viewerSource, "Tauri viewer executable");

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

fs.copyFileSync(viewerSource, path.join(outputDir, "WonRemote Viewer.exe"));
fs.copyFileSync(viewerSource, path.join(outputDir, "WonRemote Agent.exe"));

for (const directory of requiredResourceDirs) {
  copyDirectory(directory);
}

const installerDir = path.join(releaseTarget, "bundle", "nsis");
if (fs.existsSync(installerDir)) {
  const expectedInstaller = `WonRemote Viewer_${packageJson.version}_x64-setup.exe`;
  const expectedInstallerPath = path.join(installerDir, expectedInstaller);
  ensureExists(expectedInstallerPath, "current WonRemote NSIS installer");
  for (const entry of fs.readdirSync(installerDir)) {
    if (entry === expectedInstaller) {
      fs.copyFileSync(path.join(installerDir, entry), path.join(outputDir, entry));
      fs.copyFileSync(path.join(installerDir, entry), path.join(outputDir, stableInstallerName));
    }
  }
}

writeReadme();
createPortableZip();
createAgentPortableZip();

console.log(`Portable EXE package created at ${outputDir}`);
