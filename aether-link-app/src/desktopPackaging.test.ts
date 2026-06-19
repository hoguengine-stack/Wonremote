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

  it("installs viewer and agent builds under separate WonRemote folders", () => {
    const config = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));
    const agentConfigPath = path.join(projectRoot, "src-tauri", "tauri.agent.conf.json");
    const viewerHookPath = path.join(projectRoot, "src-tauri", "windows", "viewer-install-hooks.nsh");
    const agentHookPath = path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks.nsh");
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    expect(config.bundle.windows.nsis).toMatchObject({
      installerHooks: "./windows/viewer-install-hooks.nsh",
      startMenuFolder: "WonRemote",
    });
    expect(readFileSync(viewerHookPath, "utf8")).toContain('StrCpy $INSTDIR "$LOCALAPPDATA\\WonRemote\\Viewer"');

    expect(existsSync(agentConfigPath)).toBe(true);
    const agentConfig = JSON.parse(readFileSync(agentConfigPath, "utf8"));
    expect(agentConfig).toMatchObject({
      productName: "WonRemote Agent",
      identifier: "com.wonremote.agent",
    });
    expect(agentConfig.bundle.windows.nsis).toMatchObject({
      installerHooks: "./windows/agent-install-hooks.nsh",
      startMenuFolder: "WonRemote",
    });
    expect(readFileSync(agentHookPath, "utf8")).toContain('StrCpy $INSTDIR "$LOCALAPPDATA\\WonRemote\\Agent"');
    expect(packageReleaseScript).toContain("tauri.agent.conf.json");
  });

  it("resets the NSIS output path after overriding split install folders", () => {
    const viewerHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "viewer-install-hooks.nsh"), "utf8");
    const agentHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks.nsh"), "utf8");
    const viewerInstallDir = 'StrCpy $INSTDIR "$LOCALAPPDATA\\WonRemote\\Viewer"';
    const agentInstallDir = 'StrCpy $INSTDIR "$LOCALAPPDATA\\WonRemote\\Agent"';

    const viewerInstallDirIndex = viewerHook.indexOf(viewerInstallDir);
    const agentInstallDirIndex = agentHook.indexOf(agentInstallDir);

    expect(viewerInstallDirIndex).toBeGreaterThan(-1);
    expect(agentInstallDirIndex).toBeGreaterThan(-1);
    expect(viewerHook.indexOf('CreateDirectory "$INSTDIR"', viewerInstallDirIndex)).toBeGreaterThan(
      viewerInstallDirIndex,
    );
    expect(agentHook.indexOf('CreateDirectory "$INSTDIR"', agentInstallDirIndex)).toBeGreaterThan(agentInstallDirIndex);
    expect(viewerHook.indexOf("SetOutPath $INSTDIR", viewerInstallDirIndex)).toBeGreaterThan(viewerInstallDirIndex);
    expect(agentHook.indexOf("SetOutPath $INSTDIR", agentInstallDirIndex)).toBeGreaterThan(agentInstallDirIndex);
  });

  it("stops running WonRemote processes before installer overwrite", () => {
    const viewerHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "viewer-install-hooks.nsh"), "utf8");
    const agentHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks.nsh"), "utf8");

    for (const hook of [viewerHook, agentHook]) {
      expect(hook).toContain("WONREMOTE_STOP_RUNNING_PROCESSES");
      expect(hook).toContain("Get-Process");
      expect(hook).toContain("Stop-Process -Id");
      expect(hook).toContain("wonremote-viewer");
      expect(hook).toContain("WonRemote Agent");
      expect(hook).toContain("wonremote-poc");
      expect(hook).toContain("node");
      expect(hook).toContain("*\\WonRemote\\*");
      expect(hook).toContain("*WonRemote Agent*");
      expect(hook).not.toContain("Get-CimInstance");
      expect(hook).not.toContain("taskkill /F /IM node.exe");
    }
  });

  it("blocks the x64-only installers before installing on 32-bit Windows", () => {
    const viewerHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "viewer-install-hooks.nsh"), "utf8");
    const agentHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks.nsh"), "utf8");
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    for (const hook of [viewerHook, agentHook]) {
      expect(hook).toContain("!include x64.nsh");
      expect(hook).toContain("WONREMOTE_REQUIRE_X64_WINDOWS");
      expect(hook).toContain("${IfNot} ${RunningX64}");
      expect(hook).toContain("requires 64-bit Windows");
      expect(hook).toContain("Abort");
      expect(hook.indexOf("!insertmacro WONREMOTE_REQUIRE_X64_WINDOWS")).toBeLessThan(
        hook.indexOf("!insertmacro WONREMOTE_STOP_RUNNING_PROCESSES"),
      );
    }

    expect(packageReleaseScript).toContain("!include x64.nsh");
    expect(packageReleaseScript).toContain("\\${IfNot} \\${RunningX64}");
    expect(packageReleaseScript).toContain("requires 64-bit Windows");
  });

  it("allows installer update handoff to break away from the tray process job object", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
    const agentIndex = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(tauriLib).toContain("JOB_OBJECT_LIMIT_BREAKAWAY_OK");
    expect(tauriLib).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK");
    expect(agentIndex).toContain("prepareInstallerHandoff");
    expect(agentIndex).toContain("creationFlags: handoff.creationFlags");
    expect(agentIndex).not.toContain("spawn(installerPath, installerArgs");
  });

  it("starts the Agent in background after install without treating duplicate launches as failures", () => {
    const viewerHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "viewer-install-hooks.nsh"), "utf8");
    const agentHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks.nsh"), "utf8");
    const agentHookX86 = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks-x86.nsh"), "utf8");
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(agentHook).toContain("NSIS_HOOK_POSTINSTALL");
    expect(agentHook).toContain('Exec \'"$INSTDIR\\wonremote-viewer.exe" --agent --show-window\'');
    expect(agentHook).toContain('CreateShortCut "$DESKTOP\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(agentHook).toContain('CreateShortCut "$SMPROGRAMS\\WonRemote\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(agentHookX86).toContain("NSIS_HOOK_POSTINSTALL");
    expect(agentHookX86).toContain('Exec \'"$INSTDIR\\wonremote-viewer.exe" --agent --show-window\'');
    expect(agentHookX86).toContain('CreateShortCut "$DESKTOP\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(agentHookX86).toContain('CreateShortCut "$SMPROGRAMS\\WonRemote\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(viewerHook).not.toContain("NSIS_HOOK_POSTINSTALL");
    expect(tauriLib).toContain("duplicate instance ignored; existing instance is already running");
    expect(tauriLib).toContain("std::process::exit(0);");
    expect(tauriLib).not.toContain("single-instance guard already held; exiting");
  });

  it("exposes desktop packaging npm scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      "desktop:dev": "tauri dev",
      "desktop:build": "tauri build",
      "firebase:deploy": "powershell -ExecutionPolicy Bypass -File scripts/deploy-firebase.ps1",
      "firebase:deploy:spark": "powershell -ExecutionPolicy Bypass -File scripts/deploy-firebase.ps1 -SparkOnly",
      "firebase:deploy:spark:no-storage": "powershell -ExecutionPolicy Bypass -File scripts/deploy-firebase.ps1 -SparkOnly -SkipStorage",
      "firebase:verify": "node scripts/verify-firebase-deploy-readiness.js",
      "release:exes": "node scripts/package-release-exes.js",
      "release:manifest": "node scripts/create-update-manifest.js",
      "release:keypair": "node scripts/generate-update-keypair.js",
      "release:publish": "powershell -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1",
    });
    expect(packageJson.devDependencies["@tauri-apps/cli"]).toBeDefined();
  });

  it("deploys Firebase functions, rules, and hosting only behind an explicit gate", () => {
    const deployScriptPath = path.join(projectRoot, "scripts", "deploy-firebase.ps1");
    expect(existsSync(deployScriptPath)).toBe(true);

    const deployScript = readFileSync(deployScriptPath, "utf8");
    expect(deployScript).toContain("WONREMOTE_FIREBASE_DEPLOY_APPROVED");
    expect(deployScript).toContain("[switch]$SparkOnly");
    expect(deployScript).toContain("[switch]$SkipStorage");
    expect(deployScript).toContain('if ($DeployApproved -ne "YES")');
    expect(deployScript).toContain("npm run build");
    expect(deployScript).toContain("functions");
    expect(deployScript).toContain("firebase.json");
    expect(deployScript).toContain(".firebaserc");
    expect(deployScript).toContain('"firestore:rules,storage,hosting"');
    expect(deployScript).toContain('"firestore:rules,hosting"');
    expect(deployScript).toContain('"functions,firestore:rules,storage,hosting"');
    expect(deployScript).toContain('"functions,firestore:rules,hosting"');
    expect(deployScript).toContain("Skipping Firebase Storage rules deploy");
    expect(deployScript).toContain("firebase");
    expect(deployScript).toContain("firebase-tools");
    expect(deployScript).toContain("Get-Command npx");
  });

  it("does not render the local API URL field in Firebase Agent mode", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const stylesSource = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");

    expect(appSource).toContain("{!firebaseMode && (");
    expect(stylesSource).not.toContain('label:has(input[placeholder="http://127.0.0.1:8787"])');
  });

  it("routes Firebase file uploads through Storage before chunking starts", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");

    expect(appSource).toContain("if (isViewerFirebaseEnabled())");
    expect(appSource).toContain("await uploadFileToStorage(sessionId, {");
    expect(appSource.indexOf("await uploadFileToStorage(sessionId, {")).toBeLessThan(
      appSource.indexOf("await uploadFileChunk(sessionId, {"),
    );
  });

  it("downloads Firebase Storage file metadata through the Agent stream receiver", () => {
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(agentSource).toContain("saveTransferredFileDownloadStream");
    expect(agentSource).toContain("resolveFirebaseStorageDownloadUrl");
    expect(agentSource).toContain('file.delivery === "firebase-storage"');
    expect(agentSource).not.toContain("file.downloadUrl");
  });

  it("keeps Agent diagnostics failures detailed but throttled for low-spec x86 hosts", () => {
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(agentSource).toContain("formatExecFileFailure");
    expect(agentSource).toContain("warnDiagnosticFailureOnce");
    expect(agentSource).toContain("diagnosticFailureCache");
    expect(agentSource).toContain("stdout=");
    expect(agentSource).toContain("stderr=");
    expect(agentSource).toContain("Display inventory unavailable");
    expect(agentSource).toContain("Control diagnostics unavailable");
  });

  it("reports the running Agent binary version instead of stale local config versions", () => {
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(agentSource).toContain("const currentVersion = WONREMOTE_APP_VERSION");
    expect(agentSource).toContain("version: WONREMOTE_APP_VERSION");
    expect(agentSource).not.toContain("version: config.version,");
    expect(agentSource).not.toContain("const currentVersion = config.version ?? WONREMOTE_APP_VERSION");
  });

  it("hashes Firebase Storage uploads before creating file metadata", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");

    expect(appSource).toContain("const fileSha256 = await sha256BlobHex(file)");
    expect(appSource).toContain("fileSha256,");
  });

  it("keeps the Rust shell version aligned with the app package version", () => {
    const cargoToml = readFileSync(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8");

    expect(cargoToml).toContain(`version = "${packageJson.version}"`);
  });

  it("limits Tauri Rust build parallelism for low-memory Windows build machines", () => {
    const cargoConfig = readFileSync(path.join(projectRoot, "src-tauri", ".cargo", "config.toml"), "utf8");

    expect(cargoConfig).toContain("[build]");
    expect(cargoConfig).toContain("jobs = 1");
  });

  it("uses a memory-conservative Rust release profile for Windows packaging", () => {
    const cargoToml = readFileSync(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8");

    expect(cargoToml).toContain("[profile.release]");
    expect(cargoToml).toContain('opt-level = "s"');
    expect(cargoToml).toContain("codegen-units = 16");
    expect(cargoToml).toContain("lto = false");
    expect(cargoToml).toContain('strip = "debuginfo"');
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
      "../dist-poc/wonremote-poc.exe": "bin/wonremote-poc.exe",
    });
  });

  it("does not require a Firestore composite index for the Viewer device list", () => {
    const viewerFirebase = readFileSync(path.join(projectRoot, "src", "firebase", "viewerFirebase.ts"), "utf8");

    expect(viewerFirebase).not.toContain('orderBy("storeName")');
    expect(viewerFirebase).not.toContain('orderBy("deviceNumber")');
    expect(viewerFirebase).toContain("sortDevices(");
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

  it("recovers a missing Firebase device document before giving up on a saved Agent config", () => {
    const agentEntry = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(agentEntry).toContain("recoverMissingAgentRegistration");
    expect(agentEntry).toContain("recoverConfigAfterMissingDevice");
    expect(agentEntry).toContain("activeConfig = recoveredConfig");
    expect(agentEntry).toContain("await sendHeartbeat(activeConfig)");
    expect(agentEntry).toContain("void runAgentTick(activeConfig)");
  });

  it("authenticates the Agent with Firebase again when a saved config is reused", () => {
    const agentEntry = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const agentFirebase = readFileSync(path.join(projectRoot, "src", "firebase", "agentFirebase.ts"), "utf8");

    expect(agentFirebase).toContain("authenticateAgentWithFirebase");
    expect(agentEntry).toContain("ensureFirebaseAgentAuth");
    expect(agentEntry).toContain("await ensureFirebaseAgentAuth(activeConfig)");
  });

  it("hides the local server URL field from the Firebase Agent registration UI", () => {
    const appTsx = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const styles = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");

    expect(appTsx).toContain("const firebaseMode = isViewerFirebaseEnabled();");
    expect(appTsx).toContain("firebase-agent-panel");
    expect(appTsx).toContain("{!firebaseMode && (");
    expect(appTsx).toContain("apiUrl: firebaseMode ? undefined : apiUrl");
    expect(styles).not.toContain(".firebase-agent-panel label:has");
  });

  it("can package separate viewer and agent portable executables", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    expect(packageReleaseScript).toContain("WonRemote Viewer.exe");
    expect(packageReleaseScript).toContain("WonRemote Agent.exe");
    expect(packageReleaseScript).toContain("WonRemote-Agent-Setup.exe");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Agent-Setup.exe");
    expect(packageReleaseScript).toContain("createCombinedInstaller");
    expect(packageReleaseScript).toContain("makensis.exe");
    expect(packageReleaseScript).not.toContain("copyInstaller(viewerInstallerPath, stableFullInstallerName)");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Agent-Portable.zip");
    expect(packageReleaseScript).toContain("WonRemote-Agent-Portable.zip");
    expect(packageReleaseScript).toContain("WONREMOTE_DEFAULT_APP_MODE");
    expect(packageReleaseScript).toContain("Compress-Archive");
    expect(packageReleaseScript).toContain("server");
    expect(packageReleaseScript).toContain("runtime");
  });

  it("defines a dedicated 32-bit Windows release lane alongside the existing x64 assets", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const publishScript = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    const firebaseConfig = JSON.parse(readFileSync(path.join(projectRoot, "..", "firebase.json"), "utf8"));
    const redirects = Object.fromEntries(
      firebaseConfig.hosting.redirects.map((redirect: { source: string; destination: string }) => [
        redirect.source,
        redirect.destination,
      ]),
    );

    expect(packageReleaseScript).toContain("TARGET_ARCHITECTURES");
    expect(packageReleaseScript).toContain("i686-pc-windows-msvc");
    expect(packageReleaseScript).toContain("WONREMOTE_BUILD_ARCH");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(packageReleaseScript).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Agent-Setup-x86.exe");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Agent-Portable-x86.zip");
    expect(packageReleaseScript).toContain("WonRemote-Agent-Portable-x86.zip");

    expect(publishScript).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(publishScript).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(publishScript).toContain("WonRemote-Viewer-Agent-Setup-x86.exe");
    expect(publishScript).toContain("WonRemote-Viewer-Agent-Portable-x86.zip");
    expect(publishScript).toContain("WonRemote-Agent-Portable-x86.zip");
    expect(publishScript).toContain('WonRemote Viewer_${Version}_x86-setup.exe');
    expect(publishScript).toContain('WonRemote Agent_${Version}_x86-setup.exe');
    expect(publishScript).toContain("Publish-Asset $InstallerPathX86 $InstallerAssetNameX86");
    expect(publishScript).toContain("Publish-Asset $AgentInstallerPathX86 $AgentInstallerAssetNameX86");

    expect(redirects["/download/viewer-x86"]).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(redirects["/download/agent-x86"]).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(redirects["/download/viewer-agent-x86"]).toContain("WonRemote-Viewer-Agent-Setup-x86.exe");
    expect(redirects["/download/portable-x86"]).toContain("WonRemote-Viewer-Agent-Portable-x86.zip");
    expect(redirects["/download/agent-portable-x86"]).toContain("WonRemote-Agent-Portable-x86.zip");
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
    expect(manifestScript).toContain("WonRemote-Viewer-Agent-Setup.exe");
    expect(manifestScript).toContain("WonRemote-Viewer-Agent-Setup-x86.exe");
    expect(manifestScript).toContain("windows.x86");
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

  it("can publish the installer and manifest to a GitHub Release only after the release gate is approved", () => {
    const publishScriptPath = path.join(projectRoot, "scripts", "publish-github-release.ps1");
    expect(existsSync(publishScriptPath)).toBe(true);

    const publishScript = readFileSync(publishScriptPath, "utf8");
    expect(publishScript).toContain("GITHUB_TOKEN");
    expect(publishScript).toContain("WONREMOTE_RELEASE_GATE_APPROVED");
    expect(publishScript).toContain('if ($ReleaseGateApproved -ne "YES")');
    expect(publishScript).toContain("WonRemote release gate is locked.");
    expect(publishScript).toContain("[string]$Repository = \"hoguengine-stack/Wonremote\"");
    expect(publishScript).toContain("api.github.com/repos/$Repository/releases");
    expect(publishScript).toContain("uploads.github.com/repos/$Repository/releases");
    expect(publishScript).toContain("WonRemote Viewer_");
    expect(publishScript).toContain("WonRemote Agent_");
    expect(publishScript).toContain("WonRemote-Viewer-Setup.exe");
    expect(publishScript).toContain("WonRemote-Agent-Setup.exe");
    expect(publishScript).toContain("WonRemote-Viewer-Agent-Setup.exe");
    expect(publishScript).toContain("WonRemote-Viewer-Agent-Portable.zip");
    expect(publishScript).toContain("WonRemote-Agent-Portable.zip");
    expect(publishScript).toContain("$StableAgentInstallerPath");
    expect(publishScript).toContain("$AgentInstallerPath");
    expect(publishScript).toContain("$InstallerPathX86");
    expect(publishScript).toContain("$AgentInstallerPathX86");
    expect(publishScript).toContain("Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName");
    expect(publishScript).toContain("wonremote-update-manifest.json");
  });

  it("exposes the four public download redirects plus the agent portable diagnostic link", () => {
    const firebaseConfig = JSON.parse(readFileSync(path.join(projectRoot, "..", "firebase.json"), "utf8"));
    const redirects = Object.fromEntries(
      firebaseConfig.hosting.redirects.map((redirect: { source: string; destination: string }) => [
        redirect.source,
        redirect.destination,
      ]),
    );

    expect(redirects["/download/viewer"]).toContain("WonRemote-Viewer-Setup.exe");
    expect(redirects["/download/agent"]).toContain("WonRemote-Agent-Setup.exe");
    expect(redirects["/download/portable"]).toContain("WonRemote-Viewer-Agent-Portable.zip");
    expect(redirects["/download/viewer-agent"]).toContain("WonRemote-Viewer-Agent-Setup.exe");
    expect(redirects["/download/agent-portable"]).toContain("WonRemote-Agent-Portable.zip");
  });

  it("verifies delivery against the split WonRemote install folders", () => {
    const verifyDeliveryScript = readFileSync(path.join(projectRoot, "scripts", "verify-delivery.ps1"), "utf8");

    expect(verifyDeliveryScript).toContain("$env:LOCALAPPDATA\\WonRemote\\Viewer");
    expect(verifyDeliveryScript).toContain("$env:LOCALAPPDATA\\WonRemote\\Agent");
    expect(verifyDeliveryScript).not.toContain("$env:LOCALAPPDATA\\WonRemote Viewer");
  });

  it("shows OS architecture in the Windows registry diagnostic script", () => {
    const registryStatusScript = readFileSync(path.join(projectRoot, "scripts", "check-registry-status.bat"), "utf8");

    expect(registryStatusScript).toContain("wmic os get OSArchitecture");
    expect(registryStatusScript).toContain("OSArchitecture:");
    expect(registryStatusScript).toContain("requires 64-bit Windows");
  });

  it("does not require a system Node installation at runtime", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(tauriLib).toContain('resource_dir.join("runtime").join("node.exe")');
    expect(tauriLib).not.toContain('Command::new("node")');
  });

  it("keeps the viewer shell from spawning a second agent worker", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
    const viewerModeSetup = tauriLib.slice(
      tauriLib.indexOf("// Viewer Mode Setup"),
      tauriLib.indexOf("// Show window for Viewer"),
    );

    expect(viewerModeSetup).toContain("start_local_api_server_for_mode");
    expect(viewerModeSetup).not.toContain("agent_cmd");
    expect(viewerModeSetup).not.toContain('arg("--watch")');
  });

  it("starts the bundled local API server before agent registration or heartbeat", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(tauriLib).toContain("start_production_api_server_if_needed");
    expect(tauriLib).toContain("start_local_api_server_for_mode(&job, &resource_dir)?;");
    expect(tauriLib.indexOf("start_local_api_server_for_mode(&job, &resource_dir)?;")).toBeLessThan(
      tauriLib.indexOf("if is_agent_registered()"),
    );
  });

  it("restores a persisted Firebase Viewer session without storing the password", () => {
    const appTsx = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const viewerApi = readFileSync(path.join(projectRoot, "src", "api", "viewerApi.ts"), "utf8");
    const viewerFirebase = readFileSync(path.join(projectRoot, "src", "firebase", "viewerFirebase.ts"), "utf8");

    expect(viewerFirebase).toContain("onAuthStateChanged");
    expect(viewerFirebase).toContain("subscribeViewerAuthState");
    expect(viewerApi).toContain("logoutAdmin");
    expect(viewerApi).toContain("logoutViewerWithFirebase");
    expect(appTsx).toContain("isCheckingAutoLogin");
    expect(appTsx).toContain("subscribeViewerAuthState");
    expect(appTsx).toContain("handleLogout");
    expect(appTsx).not.toContain("localStorage.setItem(\"viewer-password\"");
  });

  it("uses the Rust package version as the Tauri config fallback", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(tauriLib).toContain('env!("CARGO_PKG_VERSION")');
    expect(tauriLib).not.toContain('unwrap_or("0.1.0")');
  });
});
