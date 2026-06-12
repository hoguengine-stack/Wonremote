import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));

describe("desktop packaging scaffold", () => {
  it("uses Tauri with the existing Vite build output", () => {
    const configPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.build).toMatchObject({
      beforeDevCommand: "npm run dev",
      beforeBuildCommand: "npm run build",
      devUrl: "http://127.0.0.1:5173",
      frontendDist: "../dist",
    });
    expect(config.productName).toBe("AetherLink Viewer");
    expect(config.version).toBe(packageJson.version);
  });

  it("exposes desktop packaging npm scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      "desktop:dev": "tauri dev",
      "desktop:build": "tauri build",
      "release:exes": "npm run desktop:build && node scripts/package-release-exes.js",
    });
    expect(packageJson.devDependencies["@tauri-apps/cli"]).toBeDefined();
  });

  it("keeps the Rust shell version aligned with the app package version", () => {
    const cargoToml = readFileSync(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8");

    expect(cargoToml).toContain(`version = "${packageJson.version}"`);
  });

  it("bundles the backend scripts, Node runtime, and Rust PoC executable as desktop resources", () => {
    const config = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));

    expect(config.bundle.resources).toMatchObject({
      "../dist-server/index.mjs": "server/index.mjs",
      "../dist-agent/index.mjs": "agent/index.mjs",
      "../dist-runtime/node.exe": "runtime/node.exe",
      "../../aether-link-poc/target/release/aether-link-poc.exe": "bin/aether-link-poc.exe",
    });
  });

  it("prepares all native runtime resources during the frontend build", () => {
    const buildBackendScript = readFileSync(path.join(projectRoot, "scripts", "build-backend.js"), "utf8");

    expect(buildBackendScript).toContain("cargo build --release");
    expect(buildBackendScript).toContain("dist-runtime");
    expect(buildBackendScript).toContain("process.execPath");
  });

  it("can package separate viewer and agent portable executables", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    expect(packageReleaseScript).toContain("AetherLink Viewer.exe");
    expect(packageReleaseScript).toContain("AetherLink Agent.exe");
    expect(packageReleaseScript).toContain("server");
    expect(packageReleaseScript).toContain("runtime");
  });

  it("does not require a system Node installation at runtime", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(tauriLib).toContain('resource_dir.join("runtime").join("node.exe")');
    expect(tauriLib).not.toContain('Command::new("node")');
  });

  it("keeps the viewer shell from spawning a second agent worker", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
    const productionStart = tauriLib.slice(
      tauriLib.indexOf("fn start_production_processes"),
      tauriLib.indexOf("pub fn run()"),
    );

    expect(productionStart).toContain("start_production_api_server_if_needed");
    expect(productionStart).not.toContain("agent_cmd");
    expect(productionStart).not.toContain('arg("--watch")');
  });

  it("starts the bundled local API server before agent registration or heartbeat", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(tauriLib).toContain("start_production_api_server_if_needed");
    expect(tauriLib).toContain("start_local_api_server_for_mode(&job, &resource_dir)?;");
    expect(tauriLib.indexOf("start_local_api_server_for_mode(&job, &resource_dir)?;")).toBeLessThan(
      tauriLib.indexOf("if is_agent_registered()"),
    );
  });

  it("uses the Rust package version as the Tauri config fallback", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(tauriLib).toContain('env!("CARGO_PKG_VERSION")');
    expect(tauriLib).not.toContain('unwrap_or("0.1.0")');
  });
});
