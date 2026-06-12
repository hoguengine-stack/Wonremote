import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");

async function run() {
  const pkgDir = path.join(appRoot, "dist-agent-pkg");
  const binDir = path.join(pkgDir, "bin");

  console.log(`Creating agent package directory at ${pkgDir}...`);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const nodeSrc = path.join(appRoot, "dist-runtime", "node.exe");
  const nodeDest = path.join(pkgDir, "node.exe");

  const agentSrc = path.join(appRoot, "dist-agent", "index.mjs");
  const agentDest = path.join(pkgDir, "agent.mjs");

  const agentMapSrc = path.join(appRoot, "dist-agent", "index.mjs.map");
  const agentMapDest = path.join(pkgDir, "agent.mjs.map");

  const pocSrc = path.join(repoRoot, "aether-link-poc", "target", "release", "wonremote-poc.exe");
  const pocDest = path.join(binDir, "wonremote-poc.exe");

  console.log("Copying bundled Node runtime...");
  fs.copyFileSync(nodeSrc, nodeDest);

  console.log("Copying Agent bundle...");
  fs.copyFileSync(agentSrc, agentDest);
  if (fs.existsSync(agentMapSrc)) {
    fs.copyFileSync(agentMapSrc, agentMapDest);
  }

  console.log("Copying Rust PoC capture binary...");
  fs.copyFileSync(pocSrc, pocDest);

  console.log("Creating launcher batch file wonremote-agent.bat...");
  const batContent = `@echo off
cd /d "%~dp0"
node.exe agent.mjs --watch
`;
  fs.writeFileSync(path.join(pkgDir, "wonremote-agent.bat"), batContent, "utf8");

  console.log("Agent standalone packaging completed successfully at dist-agent-pkg/!");
}

run().catch((err) => {
  console.error("Agent packaging failed:", err);
  process.exit(1);
});
