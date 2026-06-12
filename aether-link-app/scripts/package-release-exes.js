import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseTarget = path.join(appRoot, "src-tauri", "target", "release");
const outputDir = path.join(appRoot, "release-exe");

const viewerSource = path.join(releaseTarget, "aether-link-viewer.exe");
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
  const content = `# AetherLink Portable EXE Package

Run these files from this folder:

- AetherLink Viewer.exe: opens the Viewer UI.
- AetherLink Agent.exe: starts Agent tray/background mode. On first run, it opens the registration screen.

Do not move the EXE files away from the server/, agent/, runtime/, and bin/ folders.
`;
  fs.writeFileSync(path.join(outputDir, "README.txt"), content, "utf8");
}

ensureExists(viewerSource, "Tauri viewer executable");

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

fs.copyFileSync(viewerSource, path.join(outputDir, "AetherLink Viewer.exe"));
fs.copyFileSync(viewerSource, path.join(outputDir, "AetherLink Agent.exe"));

for (const directory of requiredResourceDirs) {
  copyDirectory(directory);
}

const installerDir = path.join(releaseTarget, "bundle", "nsis");
if (fs.existsSync(installerDir)) {
  for (const entry of fs.readdirSync(installerDir)) {
    if (entry.endsWith("_x64-setup.exe")) {
      fs.copyFileSync(path.join(installerDir, entry), path.join(outputDir, entry));
    }
  }
}

writeReadme();

console.log(`Portable EXE package created at ${outputDir}`);
