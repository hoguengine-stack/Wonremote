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

  it("keeps x64 and x86 Agent registration windows compact and non-resizable", () => {
    for (const configName of ["tauri.agent.conf.json", "tauri.agent.x86.conf.json"]) {
      const config = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", configName), "utf8"));
      expect(config.app.windows[0]).toMatchObject({
        width: 340,
        height: 410,
        minWidth: 340,
        minHeight: 410,
        maxWidth: 340,
        maxHeight: 410,
        resizable: false,
      });
    }

    const styles = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    expect(styles).toContain(".agent-screen .agent-panel");
  });

  it("keeps a completed Agent registration when startup integration is degraded", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const tauriSource = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(appSource).toContain('const persistedConfig = await invoke<any>("get_agent_config")');
    expect(appSource).toContain("persistedConfig?.registeredDeviceId === configData.registeredDeviceId");
    expect(tauriSource).toContain("startup registry update failed after config save");
    expect(tauriSource).toContain("job assign failed; child terminated");
    expect(tauriSource).toContain("failed to assign Agent child to cleanup job");
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
    const processStopper = readFileSync(
      path.join(projectRoot, "src-tauri", "windows", "stop-wonremote-processes.ps1"),
      "utf8",
    );

    for (const [hook, product] of [[viewerHook, "Viewer"], [agentHook, "Agent"]]) {
      expect(hook).toContain("WONREMOTE_STOP_RUNNING_PROCESSES");
      expect(hook).toContain("stop-wonremote-processes.ps1");
      expect(hook).toContain(`-Product ${product} -Architecture x64`);
      expect(hook).toContain("SetErrorLevel $1");
      expect(hook).not.toContain("Get-Process");
      expect(hook).not.toContain("taskkill");
    }

    expect(processStopper).toContain('Join-Path $env:LOCALAPPDATA "WonRemote\\$Product"');
    expect(processStopper).toContain("Get-CimInstance Win32_Process");
    expect(processStopper).toContain("Stop-Process -Id");
    expect(processStopper).toContain("Test-TargetArchitecture");
    expect(processStopper).toContain("$remainingIds.Count -gt 0");
    expect(processStopper).not.toContain("Get-Process");
    expect(processStopper).not.toContain("taskkill");
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

  it("defers normal Agent launch until the installer finish page", () => {
    const viewerHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "viewer-install-hooks.nsh"), "utf8");
    const agentHook = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks.nsh"), "utf8");
    const agentHookX86 = readFileSync(path.join(projectRoot, "src-tauri", "windows", "agent-install-hooks-x86.nsh"), "utf8");
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(agentHook).toContain("NSIS_HOOK_POSTINSTALL");
    expect(agentHook).not.toContain('Exec \'"$INSTDIR\\wonremote-viewer.exe" --agent --show-window\'');
    expect(agentHook).toContain('CreateShortCut "$DESKTOP\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(agentHook).toContain('CreateShortCut "$SMPROGRAMS\\WonRemote\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(agentHookX86).toContain("NSIS_HOOK_POSTINSTALL");
    expect(agentHookX86).not.toContain('Exec \'"$INSTDIR\\wonremote-viewer.exe" --agent --show-window\'');
    expect(agentHookX86).toContain('CreateShortCut "$DESKTOP\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(agentHookX86).toContain('CreateShortCut "$SMPROGRAMS\\WonRemote\\WonRemote Agent.lnk" "$INSTDIR\\wonremote-viewer.exe" "--agent --show-window"');
    expect(viewerHook).not.toContain("NSIS_HOOK_POSTINSTALL");
    expect(tauriLib).toContain("duplicate instance ignored; existing instance is already running");
    expect(tauriLib).toContain("std::process::exit(0);");
    expect(tauriLib).toContain("agent x86 Win32 tray starting");
    expect(tauriLib).toContain("agent x86 Win32 shell tray registered");
    expect(tauriLib).not.toContain("agent x86 tray interactions disabled; icon-only mode");
    expect(tauriLib).not.toContain("agent x86 tray disabled; shortcut-only mode");
    expect(tauriLib).not.toContain("single-instance guard already held; exiting");
  });

  it("removes startup entries and custom Agent shortcuts during x86 and x64 uninstall", () => {
    const hookPaths = [
      "viewer-install-hooks.nsh",
      "viewer-install-hooks-x86.nsh",
      "agent-install-hooks.nsh",
      "agent-install-hooks-x86.nsh",
    ];
    const hooks = hookPaths.map((name) =>
      readFileSync(path.join(projectRoot, "src-tauri", "windows", name), "utf8"),
    );

    for (const hook of hooks) {
      expect(hook).toContain("NSIS_HOOK_PREUNINSTALL");
      expect(hook).toContain("WONREMOTE_STOP_RUNNING_PROCESSES");
    }
    for (const hook of hooks.slice(0, 2)) {
      expect(hook).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "WonRemoteViewer"');
    }
    for (const hook of hooks.slice(2)) {
      expect(hook).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "WonRemoteAgent"');
      expect(hook).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "WonRemoteAgentCLI"');
      expect(hook).toContain('Delete "$DESKTOP\\WonRemote Agent.lnk"');
      expect(hook).toContain('Delete "$SMPROGRAMS\\WonRemote\\WonRemote Agent.lnk"');
    }
  });

  it("compile-gates the x86 native tray so x64 builds cannot compile that code path", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    const x86OnlyPatterns = [
      /#\[cfg\(target_arch = "x86"\)\]\s+use windows_sys::Win32::Foundation::\{HWND, LPARAM, LRESULT, WPARAM\};/,
      /#\[cfg\(target_arch = "x86"\)\]\s+use windows_sys::Win32::UI::Shell::\{[\s\S]*?Shell_NotifyIconW[\s\S]*?NOTIFYICONDATAW[\s\S]*?\};/,
      /#\[cfg\(target_arch = "x86"\)\]\s+use windows_sys::Win32::UI::WindowsAndMessaging::\{[\s\S]*?CreateWindowExW[\s\S]*?WNDCLASSW[\s\S]*?\};/,
      /#\[cfg\(target_arch = "x86"\)\]\s+const WIN32_AGENT_TRAY_ID: u32 = 37;/,
      /#\[cfg\(target_arch = "x86"\)\]\s+const WM_WONREMOTE_AGENT_TRAY: u32 = WM_APP \+ 37;/,
      /#\[cfg\(target_arch = "x86"\)\]\s+pub struct Win32AgentTray/,
      /#\[cfg\(target_arch = "x86"\)\]\s+unsafe impl Send for Win32AgentTray/,
      /#\[cfg\(target_arch = "x86"\)\]\s+unsafe impl Sync for Win32AgentTray/,
      /#\[cfg\(target_arch = "x86"\)\]\s+impl Drop for Win32AgentTray/,
      /#\[cfg\(target_arch = "x86"\)\]\s+win32_tray: Arc<Mutex<Option<Win32AgentTray>>>,/,
      /#\[cfg\(target_arch = "x86"\)\]\s+win32_tray: Arc::new\(Mutex::new\(None\)\),/,
      /#\[cfg\(target_arch = "x86"\)\]\s+fn tray_tooltip/,
      /#\[cfg\(target_arch = "x86"\)\]\s+fn win32_agent_tray_class_name/,
      /#\[cfg\(target_arch = "x86"\)\]\s+fn start_win32_agent_tray/,
      /#\[cfg\(target_arch = "x86"\)\]\s+unsafe extern "system" fn win32_agent_tray_proc/,
      /#\[cfg\(target_arch = "x86"\)\]\s+fn start_arch_specific_agent_tray/,
    ];

    for (const pattern of x86OnlyPatterns) {
      expect(tauriLib).toMatch(pattern);
    }

    expect(tauriLib).toMatch(/#\[cfg\(not\(target_arch = "x86"\)\)\]\s+fn agent_tray_enabled\(\) -> bool/);
    expect(tauriLib).toMatch(/#\[cfg\(target_arch = "x86"\)\]\s+fn agent_tray_enabled\(\) -> bool/);
    expect(tauriLib).toMatch(/#\[cfg\(not\(target_arch = "x86"\)\)\]\s+fn start_arch_specific_agent_tray/);
    expect(tauriLib).not.toContain('cfg!(target_arch = "x86")');
    expect(tauriLib).not.toContain("agent_win32_tray_enabled");
    expect(tauriLib).not.toContain("agent_tray_backend");
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

  it("stages distinct Viewer and Agent executables after their respective icon builds", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const viewerStage = packageReleaseScript.indexOf("buildViewerInstaller(target)");
    const agentBuild = packageReleaseScript.indexOf("buildAgentDefaultInstaller(target)", viewerStage);
    const agentStage = packageReleaseScript.indexOf("createProductInstaller(expectedInstallerPath", agentBuild);

    expect(viewerStage).toBeGreaterThan(-1);
    expect(agentBuild).toBeGreaterThan(viewerStage);
    expect(agentStage).toBeGreaterThan(agentBuild);
    expect(packageReleaseScript).toContain("createProductInstaller(expectedInstallerPath, expectedAgentInstallerPath, target, \"viewer\")");
    expect(packageReleaseScript).toContain("createProductInstaller(expectedInstallerPath, expectedAgentInstallerPath, target, \"agent\")");
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

  it("keeps the focused remote session and its controls inside the desktop viewport", () => {
    const stylesSource = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");

    expect(stylesSource).toContain("height: 100vh;");
    expect(stylesSource).toContain("max-height: 100vh;");
    expect(stylesSource).toContain(".remote-focus-mode .session-actions-top");
    expect(stylesSource).toContain("max-height: none;");
    expect(stylesSource).toContain("order: -1;");
    expect(stylesSource).toContain("overflow: visible;");
    expect(stylesSource).toContain("max-width: 100%;");
    expect(stylesSource).toContain("width: auto !important;");
  });

  it("routes Firebase file uploads through Storage before chunking starts", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");

    expect(appSource).toContain("if (isViewerFirebaseEnabled())");
    expect(appSource).toContain("await uploadFileToStorage(sessionId, {");
    expect(appSource.indexOf("await uploadFileToStorage(sessionId, {")).toBeLessThan(
      appSource.indexOf("await uploadFileChunk(sessionId, {"),
    );
  });

  it("keeps the synthetic crash marker strictly inside the test runtime", () => {
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const crashMarker = agentSource.indexOf('path.join(process.cwd(), "crash.txt")');
    const testGate = agentSource.lastIndexOf('process.env.NODE_ENV === "test"', crashMarker);

    expect(crashMarker).toBeGreaterThan(-1);
    expect(testGate).toBeGreaterThan(-1);
    expect(crashMarker - testGate).toBeLessThan(100);
    expect(agentSource).toContain('set "NODE_ENV=${nodeEnv}"');
    expect(agentSource).toContain('set "WONREMOTE_TEST_AGENT_UPDATE_CHECK_MS=${testUpdateCheckMs}"');
  });

  it("downloads Firebase Storage file metadata through the Agent stream receiver", () => {
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(agentSource).toContain("downloadFirebaseStorageFile");
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
    const blobHashSource = readFileSync(path.join(projectRoot, "src", "domain", "blobHash.ts"), "utf8");

    expect(appSource).toContain("const fileSha256 = await sha256BlobHex(file)");
    expect(appSource).toContain("fileSha256,");
    expect(blobHashSource).toContain("sha256.create()");
    expect(blobHashSource).toContain("blob.slice(offset, offset + chunkBytes)");
    expect(blobHashSource).not.toContain("blob.arrayBuffer()");
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
    const viewerDeviceList = readFileSync(path.join(projectRoot, "src", "domain", "viewerDeviceList.ts"), "utf8");

    expect(viewerFirebase).not.toContain('orderBy("storeName")');
    expect(viewerFirebase).not.toContain('orderBy("deviceNumber")');
    expect(viewerFirebase).toContain("prepareViewerDeviceList(");
    expect(viewerDeviceList).toContain("sortDevices(");
  });

  it("prepares all native runtime resources during the frontend build", () => {
    const buildBackendScript = readFileSync(path.join(projectRoot, "scripts", "build-backend.js"), "utf8");

    expect(buildBackendScript).toContain("cargo build --release");
    expect(buildBackendScript).toContain("dist-runtime");
    expect(buildBackendScript).toContain("process.execPath");
  });

  it("injects portable CMake and NASM for both x64 and x86 PoC builds", () => {
    const buildBackendScript = readFileSync(path.join(projectRoot, "scripts", "build-backend.js"), "utf8");
    const envStart = buildBackendScript.indexOf("async function buildEnvWithNativeTools");
    const envEnd = buildBackendScript.indexOf("async function prepareBundledNodeRuntime");
    const nativeToolEnv = buildBackendScript.slice(envStart, envEnd);

    expect(nativeToolEnv).toContain("resolvePortableCmakeBinDir()");
    expect(nativeToolEnv).toContain("resolvePortableNasmBinDir()");
    expect(nativeToolEnv).not.toContain('buildArch !== "ia32"');
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

  it("packages only the four supported Viewer and Agent installers", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    expect(packageReleaseScript).toContain("WonRemote-Agent-Setup.exe");
    expect(packageReleaseScript).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(packageReleaseScript).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(packageReleaseScript).toContain("createProductInstaller");
    expect(packageReleaseScript).toContain("makensis.exe");
    expect(packageReleaseScript).not.toContain("copyInstaller(viewerInstallerPath, stableFullInstallerName)");
    expect(packageReleaseScript).not.toContain("Portable.zip");
    expect(packageReleaseScript).not.toContain("Compress-Archive");
    expect(packageReleaseScript).toContain("expectedOutputs");
    expect(packageReleaseScript).toContain("WONREMOTE_DEFAULT_APP_MODE");
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

    expect(publishScript).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(publishScript).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(publishScript).toContain("Publish-Asset $StableInstallerPathX86 $StableInstallerAssetNameX86");
    expect(publishScript).toContain("Publish-Asset $StableAgentInstallerPathX86 $StableAgentInstallerAssetNameX86");

    expect(redirects["/download/viewer-x86"]).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(redirects["/download/agent-x86"]).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(firebaseConfig.hosting.redirects).toHaveLength(4);
    for (const obsoletePath of [
      "/download/viewer-agent",
      "/download/portable",
      "/download/viewer-agent-x86",
      "/download/portable-x86",
    ]) {
      expect(redirects[obsoletePath]).toBeUndefined();
    }
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
    expect(manifestScript).toContain("WonRemote-Viewer-Setup.exe");
    expect(manifestScript).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(manifestScript).toContain("viewerWindows");
    expect(manifestScript).toContain("agentWindows");
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
    expect(publishScript).toContain("WonRemote-Viewer-Setup.exe");
    expect(publishScript).toContain("WonRemote-Agent-Setup.exe");
    expect(publishScript).toContain("$StableAgentInstallerPath");
    expect(publishScript).toContain("$StableInstallerPathX86");
    expect(publishScript).toContain("$StableAgentInstallerPathX86");
    expect(publishScript).toContain("Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName");
    expect(publishScript).toContain("wonremote-update-manifest.json");
  });

  it("exposes exactly four canonical public download redirects", () => {
    const firebaseConfig = JSON.parse(readFileSync(path.join(projectRoot, "..", "firebase.json"), "utf8"));
    const redirects = Object.fromEntries(
      firebaseConfig.hosting.redirects.map((redirect: { source: string; destination: string }) => [
        redirect.source,
        redirect.destination,
      ]),
    );

    expect(redirects["/download/viewer"]).toContain("WonRemote-Viewer-Setup.exe");
    expect(redirects["/download/agent"]).toContain("WonRemote-Agent-Setup.exe");
    expect(redirects["/download/viewer-x86"]).toContain("WonRemote-Viewer-Setup-x86.exe");
    expect(redirects["/download/agent-x86"]).toContain("WonRemote-Agent-Setup-x86.exe");
    expect(Object.keys(redirects).filter((key) => key.startsWith("/download/")).sort()).toEqual([
      "/download/agent",
      "/download/agent-x86",
      "/download/viewer",
      "/download/viewer-x86",
    ]);
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

  it("enforces the four-installer release contract and restart-mode wrapper", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const publishScript = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    const manifestScript = readFileSync(path.join(projectRoot, "scripts", "create-update-manifest.js"), "utf8");
    for (const asset of [
      "WonRemote-Viewer-Setup.exe",
      "WonRemote-Agent-Setup.exe",
      "WonRemote-Viewer-Setup-x86.exe",
      "WonRemote-Agent-Setup-x86.exe",
    ]) {
      expect(publishScript).toContain(asset);
    }
    const packageMain = packageReleaseScript.slice(packageReleaseScript.indexOf("function main()"));
    expect(packageMain).toContain("expectedOutputs");
    expect(packageMain).toContain("Four WonRemote product installers created");
    expect(publishScript).toContain("Publish-Asset $ManifestPath $ManifestName");
    expect(publishScript.match(/^Publish-Asset /gm)?.length).toBe(5);
    expect(manifestScript).toContain("viewerWindows");
    expect(manifestScript).toContain("agentWindows");
    expect(manifestScript).toContain("release-tag");
    expect(manifestScript).not.toContain("latest/download");
    expect(packageReleaseScript).toContain("WONREMOTE_RESTART_MODE");
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

  it("checks installed Viewer updates from the native shell instead of the WebView", () => {
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
    const appTsx = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const viewerModeSetup = tauriLib.slice(
      tauriLib.indexOf("// Viewer Mode Setup"),
      tauriLib.indexOf("// Show window for Viewer"),
    );
    const agentModeSetup = tauriLib.slice(
      tauriLib.indexOf("// Agent Mode Setup"),
      tauriLib.indexOf("// Viewer Mode Setup"),
    );

    expect(tauriLib).toContain("fn start_viewer_update_watcher");
    expect(viewerModeSetup).toContain("start_viewer_update_watcher(app.handle().clone())");
    expect(agentModeSetup).not.toContain("start_viewer_update_watcher");
    expect(tauriLib).toContain('.env("WONREMOTE_UPDATE_PRODUCT", restart_mode)');
    expect(tauriLib).toContain('.env("WONREMOTE_TAURI_UPDATE_BROKER", "1")');
    expect(tauriLib).toContain("launch_brokered_update_handoff");
    expect(appTsx).not.toContain('invoke("start_installer_update"');
    expect(appTsx).toContain("Native Viewer shell owns installed-app updates");
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
