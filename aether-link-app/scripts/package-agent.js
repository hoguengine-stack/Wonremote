import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function run() {
  const pkgDir = path.join(appRoot, "dist-agent-pkg");
  const binDir = path.join(pkgDir, "bin");
  const nodeModulesDir = path.join(pkgDir, "node_modules");

  console.log(`Creating agent package directory at ${pkgDir}...`);
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(nodeModulesDir, { recursive: true });

  const nodeSrc = path.join(appRoot, "dist-runtime", "node.exe");
  const nodeDest = path.join(pkgDir, "node.exe");

  const agentSrc = path.join(appRoot, "dist-agent", "index.mjs");
  const agentDest = path.join(pkgDir, "agent.mjs");

  const agentMapSrc = path.join(appRoot, "dist-agent", "index.mjs.map");
  const agentMapDest = path.join(pkgDir, "agent.mjs.map");

  const pocSrc = path.join(appRoot, "dist-poc", "wonremote-poc.exe");
  const pocDest = path.join(binDir, "wonremote-poc.exe");
  const pocRuntimeSrc = path.join(appRoot, "dist-poc", "vcruntime140.dll");
  const pocRuntimeDest = path.join(binDir, "vcruntime140.dll");

  console.log("Copying bundled Node runtime...");
  fs.copyFileSync(nodeSrc, nodeDest);

  console.log("Copying Agent bundle...");
  fs.copyFileSync(agentSrc, agentDest);
  if (fs.existsSync(agentMapSrc)) {
    fs.copyFileSync(agentMapSrc, agentMapDest);
  }

  console.log("Copying Rust PoC capture binary...");
  fs.copyFileSync(pocSrc, pocDest);
  if (fs.existsSync(pocRuntimeSrc)) {
    console.log("Copying Rust PoC VC runtime dependency...");
    fs.copyFileSync(pocRuntimeSrc, pocRuntimeDest);
  }

  console.log("Copying native WebRTC runtime...");
  fs.cpSync(
    path.join(appRoot, "dist-native", "node-datachannel"),
    path.join(nodeModulesDir, "node-datachannel"),
    { recursive: true },
  );

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
