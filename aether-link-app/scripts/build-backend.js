import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
}

function prepareBundledNodeRuntime() {
  const runtimeDir = path.join(appRoot, "dist-runtime");
  const nodeDestination = path.join(runtimeDir, "node.exe");

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(process.execPath, nodeDestination);

  console.log(`Bundled Node runtime at ${path.relative(appRoot, nodeDestination)}`);
}

function buildRustPocRelease() {
  const pocDir = path.join(repoRoot, "aether-link-poc");
  const pocExe = path.join(pocDir, "target", "release", "wonremote-poc.exe");

  console.log("Building Rust PoC release binary with cargo build --release...");
  run("cargo", ["build", "--release"], pocDir);

  if (!fs.existsSync(pocExe)) {
    throw new Error(`Rust PoC release binary was not produced: ${pocExe}`);
  }
}

async function build() {
  fs.mkdirSync(path.join(appRoot, "dist-server"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "dist-agent"), { recursive: true });
  prepareBundledNodeRuntime();
  buildRustPocRelease();

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
    external: ["fsevents"],
  });

  console.log("Backend bundling completed successfully!");
}

build().catch((err) => {
  console.error("Backend build failed:", err);
  process.exit(1);
});
