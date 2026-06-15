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
    expect(config.productName).toBe("WonRemote Viewer");
    expect(config.version).toBe(packageJson.version);
  });

  it("exposes desktop packaging npm scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      "desktop:dev": "tauri dev",
      "desktop:build": "tauri build",
      "release:exes": "npm run desktop:build && node scripts/package-release-exes.js",
      "release:manifest": "node scripts/create-update-manifest.js",
      "release:keypair": "node scripts/generate-update-keypair.js",
      "release:publish": "powershell -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1",
    });
    expect(packageJson.devDependencies["@tauri-apps/cli"]).toBeDefined();
  });

  it("keeps the Rust shell version aligned with the app package version", () => {
    const cargoToml = readFileSync(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8");

    expect(cargoToml).toContain(`version = "${packageJson.version}"`);
  });

  it("builds release desktop executables without attaching a console window", () => {
    const mainRs = readFileSync(path.join(projectRoot, "src-tauri", "src", "main.rs"), "utf8");
    const libRs = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(mainRs).toContain('windows_subsystem = "windows"');
    expect(libRs).toContain("CREATE_NO_WINDOW");
    expect(libRs).toContain("command.creation_flags(CREATE_NO_WINDOW)");
  });

  it("bundles the backend scripts, Node runtime, and Rust PoC executable as desktop resources", () => {
    const config = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));

    expect(config.bundle.resources).toMatchObject({
      "../dist-server/index.mjs": "server/index.mjs",
      "../dist-agent/index.mjs": "agent/index.mjs",
      "../dist-runtime/node.exe": "runtime/node.exe",
      "../../aether-link-poc/target/release/wonremote-poc.exe": "bin/wonremote-poc.exe",
    });
  });

  it("prepares all native runtime resources during the frontend build", () => {
    const buildBackendScript = readFileSync(path.join(projectRoot, "scripts", "build-backend.js"), "utf8");

    expect(buildBackendScript).toContain("cargo build --release");
    expect(buildBackendScript).toContain("dist-runtime");
    expect(buildBackendScript).toContain("process.execPath");
  });

  it("injects createRequire into ESM backend bundles for CommonJS dependencies", () => {
    const buildBackendScript = readFileSync(path.join(projectRoot, "scripts", "build-backend.js"), "utf8");

    expect(buildBackendScript).toContain("createRequire");
    expect(buildBackendScript).toContain("banner");
    expect(buildBackendScript).toContain('outfile: "dist-server/index.mjs"');
    expect(buildBackendScript).toContain('outfile: "dist-agent/index.mjs"');
  });

  it("keeps session data polling alive when the stream process exits", () => {
    const agentEntry = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const streamCloseStart = agentEntry.indexOf('.on("close"');
    const startSessionPollingStart = agentEntry.indexOf("function startSessionPolling");
    const streamCloseBlock = agentEntry.slice(streamCloseStart, startSessionPollingStart);

    expect(streamCloseStart).toBeGreaterThan(-1);
    expect(streamCloseBlock).not.toContain("stopSessionPolling()");
  });

  it("keeps packaged Agent child processes hidden on Windows", () => {
    const agentEntry = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const apiServer = readFileSync(path.join(projectRoot, "src", "server", "apiServer.ts"), "utf8");

    expect(agentEntry).toContain("windowsHide: true");
    expect(agentEntry).toContain("creationFlags: 0x08000000");
    expect(apiServer).toContain("windowsHide: true");
  });

  it("checks the signed release manifest directly when the Agent runs in Firebase mode", () => {
    const agentEntry = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const updateLoader = readFileSync(path.join(projectRoot, "src", "agent", "productionUpdateMetadata.ts"), "utf8");

    expect(agentEntry).toContain("loadProductionInstallerUpdateMetadata(process.env)");
    expect(agentEntry).not.toContain("if (USE_FIREBASE) {\n    return;");
    expect(updateLoader).toContain("releases/latest/download/wonremote-update-manifest.json");
  });

  it("hides the local server URL field from the Firebase Agent registration UI", () => {
    const appTsx = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const styles = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");

    expect(appTsx).toContain("const firebaseMode = isViewerFirebaseEnabled();");
    expect(appTsx).toContain("firebase-agent-panel");
    expect(appTsx).toContain("apiUrl: firebaseMode ? undefined : apiUrl");
    expect(styles).toContain(".firebase-agent-panel label:has");
  });

  it("can package separate viewer and agent portable executables", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    expect(packageReleaseScript).toContain("WonRemote Viewer.exe");
    expect(packageReleaseScript).toContain("WonRemote Agent.exe");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Agent-Portable.zip");
    expect(packageReleaseScript).toContain("WonRemote-Agent-Portable.zip");
    expect(packageReleaseScript).toContain("Compress-Archive");
    expect(packageReleaseScript).toContain("server");
    expect(packageReleaseScript).toContain("runtime");
  });

  it("can create a signed production update manifest for a GitHub release installer", () => {
    const manifestScriptPath = path.join(projectRoot, "scripts", "create-update-manifest.js");
    expect(existsSync(manifestScriptPath)).toBe(true);

    const manifestScript = readFileSync(manifestScriptPath, "utf8");
    expect(manifestScript).toContain("createHash");
    expect(manifestScript).toContain("sign(null");
    expect(manifestScript).toContain("version=");
    expect(manifestScript).toContain("sha256=");
    expect(manifestScript).toContain("assetName=");
    expect(manifestScript).toContain("WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY");
  });

  it("can generate a local Ed25519 update signing key pair without committing secrets", () => {
    const keypairScriptPath = path.join(projectRoot, "scripts", "generate-update-keypair.js");
    expect(existsSync(keypairScriptPath)).toBe(true);

    const keypairScript = readFileSync(keypairScriptPath, "utf8");
    expect(keypairScript).toContain("generateKeyPairSync");
    expect(keypairScript).toContain("ed25519");
    expect(keypairScript).toContain(".local-run");
    expect(keypairScript).toContain("update-signing-private.pem");
    expect(keypairScript).toContain("update-signing-public.pem");
  });

  it("can publish the installer and manifest to a GitHub Release when a token is supplied", () => {
    const publishScriptPath = path.join(projectRoot, "scripts", "publish-github-release.ps1");
    expect(existsSync(publishScriptPath)).toBe(true);

    const publishScript = readFileSync(publishScriptPath, "utf8");
    expect(publishScript).toContain("GITHUB_TOKEN");
    expect(publishScript).toContain("[string]$Repository = \"hoguengine-stack/Wonremote\"");
    expect(publishScript).toContain("api.github.com/repos/$Repository/releases");
    expect(publishScript).toContain("uploads.github.com/repos/$Repository/releases");
    expect(publishScript).toContain("WonRemote Viewer_");
    expect(publishScript).toContain("WonRemote-Viewer-Setup.exe");
    expect(publishScript).toContain("WonRemote-Viewer-Agent-Portable.zip");
    expect(publishScript).toContain("WonRemote-Agent-Portable.zip");
    expect(publishScript).toContain("wonremote-update-manifest.json");
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
