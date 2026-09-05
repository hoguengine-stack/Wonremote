import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));

describe("desktop packaging scaffold", () => {
  it("uses Tauri with the existing Vite build output", () => {
    const configPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
    expect(existsSync(configPath)).toBe(true);
    expect(packageJson.version).toBe("0.1.80");

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
    expect(packageReleaseScript).toContain("tauri.agent.x86.conf.json");
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

  it("shows the running Agent version before and after registration", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");

    expect(appSource).toContain("const agentVersion = getViewerVersion(import.meta.env)");
    expect(appSource).toContain("Active Agent · v{agentVersion}");
    expect(appSource).toContain("Agent · v{agentVersion}");
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
      expect(hook).toContain(`-Product ${product}`);
      expect(hook).not.toContain("-Architecture");
      expect(hook).toContain("SetErrorLevel $1");
      expect(hook).not.toContain("Get-Process");
      expect(hook).not.toContain("taskkill");
    }

    expect(processStopper).toContain('Join-Path $env:LOCALAPPDATA "WonRemote\\$Product"');
    expect(processStopper).toContain("Get-CimInstance Win32_Process");
    expect(processStopper).toContain("Stop-Process -Id");
    expect(processStopper).not.toContain("Test-TargetArchitecture");
    expect(processStopper).not.toContain("$Architecture");
    expect(processStopper).toContain("$remainingIds.Count -gt 0");
    expect(processStopper).not.toContain("Get-Process");
    expect(processStopper).not.toContain("taskkill");
  });

  it("keeps legacy x64 installers guarded while releases use the x86 installer path", () => {
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

    expect(packageReleaseScript).toContain('rustTarget: "i686-pc-windows-msvc"');
    expect(packageReleaseScript).toContain('buildArch: "ia32"');
    expect(packageReleaseScript).not.toContain('key: "x64"');
    expect(packageReleaseScript).not.toContain("createUniversalProductInstaller");
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
      "release:exes": "node scripts/package-release-exes.js && node scripts/verify-x86-installer-payloads.js",
      "release:manifest": "node scripts/create-update-manifest.js",
      "release:keypair": "node scripts/generate-update-keypair.js",
      "release:publish": "powershell -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1",
    });
    expect(packageJson.devDependencies["@tauri-apps/cli"]).toBeDefined();
  });

  it("compiles one x86 app and bundles both product installers before copying stable release files", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const viewerStage = packageReleaseScript.indexOf("buildViewerInstaller(target)");
    const agentBuild = packageReleaseScript.indexOf("buildAgentDefaultInstaller(target)", viewerStage);
    const packageReturn = packageReleaseScript.indexOf("agentInstallerPath: expectedAgentInstallerPath", agentBuild);
    const copyStage = packageReleaseScript.indexOf("copyStableX86Installers(packageTarget(RELEASE_TARGET))", packageReturn);

    expect(viewerStage).toBeGreaterThan(-1);
    expect(agentBuild).toBeGreaterThan(viewerStage);
    expect(packageReturn).toBeGreaterThan(agentBuild);
    expect(copyStage).toBeGreaterThan(packageReturn);
    expect(packageReleaseScript).toContain('WONREMOTE_BUILD_STAGE: "full"');
    expect(packageReleaseScript.match(/"npx tauri build"/g)).toHaveLength(1);
    expect(packageReleaseScript.match(/"npx tauri bundle"/g)).toHaveLength(1);
    expect(packageReleaseScript).not.toContain('WONREMOTE_BUILD_STAGE: "reuse"');
    expect(packageReleaseScript).toContain('--assemble-only');
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
    expect(deployScript).toContain('if ($LASTEXITCODE -ne 0) { throw "Firebase deployment failed with exit code $LASTEXITCODE." }');
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
    expect(stylesSource).toMatch(
      /\.session-fullscreen-active \.remote-preview canvas\s*\{[^}]*height: auto !important;[^}]*max-height: 100%;[^}]*max-width: 100%;[^}]*width: auto !important;/s,
    );
    expect(stylesSource).not.toMatch(
      /(?:\.session-fullscreen-active \.remote-preview canvas|\.remote-canvas)\s*\{[^}]*object-fit:/s,
    );
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

    expect(appSource).toMatch(/fileSha256(?:\s*:\s*string)?\s*=\s*await\s+sha256BlobHex\(file\)/);
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

  it("keeps session data subscription alive when the stream process exits", () => {
    const agentEntry = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const streamCloseStart = agentEntry.indexOf('.on("close"');
    const streamCloseEnd = agentEntry.indexOf("function ensureSessionWebRtcTransport", streamCloseStart);
    const streamCloseBlock = agentEntry.slice(streamCloseStart, streamCloseEnd);

    expect(streamCloseStart).toBeGreaterThan(-1);
    expect(streamCloseEnd).toBeGreaterThan(streamCloseStart);
    expect(streamCloseBlock).not.toContain("stopSessionPolling()");
    expect(streamCloseBlock).not.toContain("sessionDataUnsubscribe");
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
    expect(agentEntry).toContain("activeConfig = await sendHeartbeatWithRecovery(activeConfig)");
    expect(agentEntry).toContain("await sendHeartbeat(activeConfig, heartbeatRequestId)");
    expect(agentEntry).not.toContain("void runAgentTick(activeConfig)");
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

  it("packages only two x86 Viewer and Agent installers", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");

    expect(packageReleaseScript).toContain("WonRemote-Agent-Setup.exe");
    expect(packageReleaseScript).toContain("Two x86 WonRemote product installers created");
    expect(packageReleaseScript).not.toContain('key: "x64"');
    expect(packageReleaseScript).toContain('key: "x86"');
    expect(packageReleaseScript).not.toContain("createUniversalProductInstaller");
    expect(packageReleaseScript).toContain("copyStableX86Installers");
    expect(packageReleaseScript).not.toContain("Portable.zip");
    expect(packageReleaseScript).not.toContain("Compress-Archive");
    expect(packageReleaseScript).toContain("expectedOutputs");
    expect(packageReleaseScript).not.toContain("WONREMOTE_DEFAULT_APP_MODE");
    expect(packageReleaseScript).toContain("server");
    expect(packageReleaseScript).toContain("runtime");
  });

  it("reuses one x86 Rust binary for Viewer and Agent packaging", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const rustBuildScript = readFileSync(path.join(projectRoot, "src-tauri", "build.rs"), "utf8");
    const rustApp = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
    const workflow = readFileSync(path.join(projectRoot, "..", ".github", "workflows", "publish-release.yml"), "utf8");

    expect(packageReleaseScript).toContain("buildTauriBundleCommand(target, target.agentConfig)");
    expect(packageReleaseScript).not.toContain("cleanTauriResourceOutput(target);\n  runShell(buildTauriBundleCommand");
    expect(packageReleaseScript).not.toContain("WONREMOTE_DEFAULT_APP_MODE");
    expect(rustBuildScript).not.toContain("cargo:rerun-if-env-changed=WONREMOTE_DEFAULT_APP_MODE");
    expect(rustApp).toContain('directory.eq_ignore_ascii_case("agent")');
    expect(workflow).not.toMatch(/key: wonremote-windows-.*github\.sha/);
  });

  it("builds only native x86 payloads behind two stable downloads", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const publishScript = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    const buildAndroidScript = readFileSync(path.join(projectRoot, "..", "mobile", "android", "build-agent-release.ps1"), "utf8");
    const firebaseConfig = JSON.parse(readFileSync(path.join(projectRoot, "..", "firebase.json"), "utf8"));
    const redirects = Object.fromEntries(
      firebaseConfig.hosting.redirects.map((redirect: { source: string; destination: string }) => [
        redirect.source,
        redirect.destination,
      ]),
    );

    expect(packageReleaseScript).toContain("RELEASE_TARGET");
    expect(packageReleaseScript).toContain("i686-pc-windows-msvc");
    expect(packageReleaseScript).toContain("WONREMOTE_BUILD_ARCH");
    expect(packageReleaseScript).not.toContain('key: "x64"');
    expect(packageReleaseScript).toContain("Two x86 WonRemote product installers created");
    expect(publishScript).not.toContain("$StableInstallerPathX86");
    expect(publishScript).not.toContain("$StableAgentInstallerPathX86");

    expect(redirects["/download/viewer-x86"]).toContain("WonRemote-Viewer-Setup.exe");
    expect(redirects["/download/agent-x86"]).toContain("WonRemote-Agent-Setup.exe");
    expect(redirects["/download/agent.apk"]).toBe("/download/agent.zip");
    expect(redirects["/download/viewer.apk"]).toBe("/download/viewer.zip");
    expect(redirects["/download/control-addon.apk"]).toBe("/download/control-addon.zip");
    expect(buildAndroidScript).toContain("Compress-Archive");
    expect(buildAndroidScript).toContain("public\\download\\agent.zip");
    expect(buildAndroidScript).toContain("public\\download\\viewer.zip");
    expect(buildAndroidScript).toContain("public\\download\\control-addon.zip");
    expect(buildAndroidScript).toContain(":agent:assembleRelease :viewer:assembleRelease :controladdon:assembleRelease");
    expect(existsSync(path.join(projectRoot, "public", "download", "agent.apk"))).toBe(false);
    expect(existsSync(path.join(projectRoot, "public", "download", "viewer.apk"))).toBe(false);
    expect(existsSync(path.join(projectRoot, "public", "download", "control-addon.apk"))).toBe(false);
    expect(firebaseConfig.hosting.redirects).toHaveLength(7);
    for (const obsoletePath of [
      "/download/viewer-agent",
      "/download/portable",
      "/download/viewer-agent-x86",
      "/download/portable-x86",
    ]) {
      expect(redirects[obsoletePath]).toBeUndefined();
    }
  });

  it("keeps Android full-display sharing explicitly stoppable", () => {
    const androidRoot = path.join(projectRoot, "..", "mobile", "android", "agent", "src", "main", "java", "com", "wonremote", "agent");
    const activity = readFileSync(path.join(androidRoot, "MainActivity.java"), "utf8");
    const service = readFileSync(path.join(androidRoot, "AgentService.java"), "utf8");

    expect(activity).toContain("MediaProjectionConfig.createConfigForDefaultDisplay()");
    expect(activity).toContain("AgentService.stopProjection(this)");
    expect(activity).toContain("Settings.ACTION_APPLICATION_DETAILS_SETTINGS");
    expect(service).toContain("ACTION_STOP_PROJECTION");
    expect(service).toContain('"화면 공유 중지"');
    expect(activity).toContain('button("앱 종료", DANGER)');
    expect(activity).toContain("AgentService.stop(this)");
    expect(activity).toContain("finishAndRemoveTask()");
    expect(service).toContain("ACTION_STOP_AGENT");
    expect(service).toContain("return START_NOT_STICKY");
    expect(service).toContain("handler.removeCallbacksAndMessages(null)");
    expect(service).toContain("stopForeground(STOP_FOREGROUND_REMOVE)");
    expect(service).toContain('"앱 종료", exit');
  });

  it("blocks Firebase deployment until the development predeploy gate passes", () => {
    const deployScript = readFileSync(path.join(projectRoot, "scripts", "deploy-firebase.ps1"), "utf8");
    expect(deployScript).toContain("npm run change:verify:predeploy");
    expect(deployScript).toContain('throw "Development predeploy gate failed."');
    expect(deployScript.indexOf("npm run change:verify:predeploy")).toBeLessThan(
      deployScript.indexOf("npm run build"),
    );
  });

  it("keeps Android screen delivery on TURN with a post-open keyframe handshake", () => {
    const androidRoot = path.join(projectRoot, "..", "mobile", "android", "agent");
    const agentBuild = readFileSync(path.join(androidRoot, "build.gradle.kts"), "utf8");
    const sourceRoot = path.join(androidRoot, "src", "main", "java", "com", "wonremote", "agent");
    const remoteSession = readFileSync(path.join(sourceRoot, "RemoteSessionController.java"), "utf8");
    const agentService = readFileSync(path.join(sourceRoot, "AgentService.java"), "utf8");
    const streamer = readFileSync(path.join(sourceRoot, "ScreenFrameStreamer.java"), "utf8");
    const viewerTransport = readFileSync(path.join(projectRoot, "src", "firebase", "viewerFirebase.ts"), "utf8");
    const windowsAgent = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(agentBuild).toContain('implementation("com.google.firebase:firebase-functions")');
    expect(remoteSession).toContain('getHttpsCallable("getRtcConfiguration")');
    expect(remoteSession).toContain("PeerConnection.IceTransportsType.RELAY");
    expect(remoteSession).toContain("RTC_CONFIG_WAIT_MS");
    expect(agentService).toContain('"request-keyframe".equals(action)');
    expect(streamer).toContain("void requestKeyframe()");
    expect(viewerTransport).toContain('controlChannel.send(serializeWebRtcControlAction("request-keyframe"))');
    expect(windowsAgent).toContain('if (action === "request-keyframe")');
  });

  it("packages a signature-protected Android control add-on with a legacy fallback", () => {
    const androidRoot = path.join(projectRoot, "..", "mobile", "android");
    const settings = readFileSync(path.join(androidRoot, "settings.gradle.kts"), "utf8");
    const agentBuild = readFileSync(path.join(androidRoot, "agent", "build.gradle.kts"), "utf8");
    const addonBuild = readFileSync(path.join(androidRoot, "controladdon", "build.gradle.kts"), "utf8");
    const addonManifest = readFileSync(path.join(androidRoot, "controladdon", "src", "main", "AndroidManifest.xml"), "utf8");
    const coreManifest = readFileSync(path.join(androidRoot, "controlcore", "src", "main", "AndroidManifest.xml"), "utf8");
    const client = readFileSync(
      path.join(androidRoot, "agent", "src", "main", "java", "com", "wonremote", "agent", "ControlAddonClient.java"),
      "utf8",
    );

    expect(settings).toContain('include(":controladdon")');
    expect(settings).toContain('include(":controlcore")');
    expect(agentBuild).toContain('implementation(project(":controlcore"))');
    expect(addonBuild).toContain('implementation(project(":controlcore"))');
    expect(addonBuild).toContain('rootProject.file("keystore.properties")');
    expect(coreManifest).toContain('android:protectionLevel="signature"');
    expect(addonManifest).toContain('android:permission="com.wonremote.permission.CONTROL_ADDON"');
    expect(client).toContain("checkSignatures");
    expect(client).toContain("context.sendBroadcast(intent, PERMISSION)");
    expect(client).toContain("WonRemoteAccessibilityService.releasePointer()");
  });

  it("auto-starts only the registered Android Agent and enabled Control Add-On", () => {
    const androidRoot = path.join(projectRoot, "..", "mobile", "android");
    const agentManifest = readFileSync(path.join(androidRoot, "agent", "src", "main", "AndroidManifest.xml"), "utf8");
    const agentBootReceiver = readFileSync(
      path.join(androidRoot, "agent", "src", "main", "java", "com", "wonremote", "agent", "BootReceiver.java"),
      "utf8",
    );
    const addonCoreManifest = readFileSync(
      path.join(androidRoot, "controlcore", "src", "main", "AndroidManifest.xml"),
      "utf8",
    );
    const viewerManifest = readFileSync(path.join(androidRoot, "viewer", "src", "main", "AndroidManifest.xml"), "utf8");

    expect(agentManifest).toContain("android.permission.RECEIVE_BOOT_COMPLETED");
    expect(agentManifest).toContain("android.intent.action.BOOT_COMPLETED");
    expect(agentManifest).toContain("android.intent.action.MY_PACKAGE_REPLACED");
    expect(agentBootReceiver).toContain("AgentService.start(context)");
    expect(agentBootReceiver).not.toContain("setProjection");
    expect(addonCoreManifest).toContain('android:directBootAware="true"');
    expect(viewerManifest).not.toContain("android.permission.RECEIVE_BOOT_COMPLETED");
    expect(viewerManifest).not.toContain("BootReceiver");
  });

  it("requests Android screen-share consent only after an explicit Viewer request", () => {
    const androidRoot = path.join(projectRoot, "..", "mobile", "android");
    const agentRoot = path.join(androidRoot, "agent", "src", "main");
    const manifest = readFileSync(path.join(agentRoot, "AndroidManifest.xml"), "utf8");
    const sourceRoot = path.join(agentRoot, "java", "com", "wonremote", "agent");
    const activity = readFileSync(path.join(sourceRoot, "MainActivity.java"), "utf8");
    const service = readFileSync(path.join(sourceRoot, "AgentService.java"), "utf8");
    const addonClient = readFileSync(path.join(sourceRoot, "ControlAddonClient.java"), "utf8");
    const remoteSession = readFileSync(path.join(sourceRoot, "RemoteSessionController.java"), "utf8");
    const accessibilityService = readFileSync(
      path.join(androidRoot, "controlcore", "src", "main", "java", "com", "wonremote", "agent", "WonRemoteAccessibilityService.java"),
      "utf8",
    );
    const addonReceiver = readFileSync(
      path.join(androidRoot, "controladdon", "src", "main", "java", "com", "wonremote", "controladdon", "ControlCommandReceiver.java"),
      "utf8",
    );
    const stopCommandBranch = service.split('if (action.startsWith("stop-stream")) {')[1]
      ?.split('if ("request-keyframe".equals(action))')[0] ?? "";
    const cancelRequestBranch = service.split("private void cancelProjectionRequest")[1]
      ?.split("private void finishRemoteSession")[0] ?? "";

    expect(manifest).toContain('android:launchMode="singleTop"');
    expect(activity).toContain("ACTION_REQUEST_SCREEN_SHARE");
    expect(activity).toContain("onNewIntent");
    expect(activity).toContain("handleLaunchIntent");
    expect(service).toContain("NotificationManager.IMPORTANCE_HIGH");
    expect(service).toContain("showProjectionRequest");
    expect(service).toContain("APPROVAL_TIMEOUT_MS");
    expect(service).toContain("shouldPromptForProjection");
    expect(service).toContain("shouldStopRemoteSession");
    expect(service).toContain("setDeleteIntent");
    expect(service).not.toContain(".setAutoCancel(true)");
    expect(service).toContain("MainActivity.isVisible()");
    expect(service).toContain("startActivity(projectionApprovalActivityIntent())");
    expect(service).toContain("WonRemoteAccessibilityService.requestScreenShareConsent()");
    expect(service).toContain("ControlAddonClient.requestScreenShareConsent(this)");
    expect(addonClient).toContain("COMMAND_REQUEST_SCREEN_SHARE_CONSENT");
    expect(addonReceiver).toContain("WonRemoteAccessibilityService.requestScreenShareConsent()");
    expect(accessibilityService).toContain("new ComponentName(AGENT_PACKAGE, AGENT_ACTIVITY)");
    expect(service).toContain("this::finishRemoteSession");
    expect(service).not.toContain('endProjection("온라인", false)');
    expect(cancelRequestBranch).toContain("if (streamer.isReady())");
    expect(stopCommandBranch).toContain("shouldStopRemoteSession");
    expect(stopCommandBranch).toContain("finishRemoteSession()");
    expect(stopCommandBranch).not.toContain("stopProjection()");
    expect(remoteSession).toContain("isCurrentSession(nextSessionId, sessionId)");
    expect(service).not.toContain("setFullScreenIntent");
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
    expect(manifestScript).toContain("viewerPathX86");
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
    expect(publishScript).toContain("WONREMOTE_SKIP_UPDATE_E2E_PREFLIGHT");
    expect(publishScript).toContain('if ($ReleaseGateApproved -ne "YES")');
    expect(publishScript).toContain("WonRemote release gate is locked.");
    expect(publishScript).toContain("[string]$Repository = \"hoguengine-stack/Wonremote\"");
    expect(publishScript).toContain("api.github.com/repos/$Repository/releases");
    expect(publishScript).toContain("uploads.github.com/repos/$Repository/releases");
    expect(publishScript).toContain("WonRemote-Viewer-Setup.exe");
    expect(publishScript).toContain("WonRemote-Agent-Setup.exe");
    expect(publishScript).toContain("$StableAgentInstallerPath");
    expect(publishScript).toContain("Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName");
    expect(publishScript).toContain("wonremote-update-manifest.json");
  });

  it("does not repeat build-job preflights while publishing the same verified artifact", () => {
    const workflow = readFileSync(path.join(projectRoot, "..", ".github", "workflows", "publish-release.yml"), "utf8");
    const publishJob = workflow.split("  publish-release:")[1];

    expect(publishJob).toContain('WONREMOTE_SKIP_BUILD_PAYLOAD_PREFLIGHT: "YES"');
    expect(publishJob).toContain('WONREMOTE_SKIP_UPDATE_E2E_PREFLIGHT: "YES"');
    expect(publishJob).not.toContain("Install publish dependencies");
  });

  it("keeps x86 download routes as compatibility aliases to the two installers", () => {
    const firebaseConfig = JSON.parse(readFileSync(path.join(projectRoot, "..", "firebase.json"), "utf8"));
    const redirects = Object.fromEntries(
      firebaseConfig.hosting.redirects.map((redirect: { source: string; destination: string }) => [
        redirect.source,
        redirect.destination,
      ]),
    );

    expect(redirects["/download/viewer"]).toContain("WonRemote-Viewer-Setup.exe");
    expect(redirects["/download/agent"]).toContain("WonRemote-Agent-Setup.exe");
    expect(redirects["/download/viewer-x86"]).toContain("WonRemote-Viewer-Setup.exe");
    expect(redirects["/download/agent-x86"]).toContain("WonRemote-Agent-Setup.exe");
    expect(Object.keys(redirects).filter((key) => key.startsWith("/download/")).sort()).toEqual([
      "/download/agent",
      "/download/agent-x86",
      "/download/agent.apk",
      "/download/control-addon.apk",
      "/download/viewer",
      "/download/viewer-x86",
      "/download/viewer.apk",
    ]);
  });

  it("verifies delivery against the split WonRemote install folders", () => {
    const verifyDeliveryScript = readFileSync(path.join(projectRoot, "scripts", "verify-delivery.ps1"), "utf8");

    expect(verifyDeliveryScript).toContain("$env:LOCALAPPDATA\\WonRemote\\Viewer");
    expect(verifyDeliveryScript).toContain("$env:LOCALAPPDATA\\WonRemote\\Agent");
    expect(verifyDeliveryScript).toContain("release-exe/WonRemote-Viewer-Setup.exe");
    expect(verifyDeliveryScript).toContain("release-exe/WonRemote-Agent-Setup.exe");
    expect(verifyDeliveryScript).not.toContain("_x64-setup.exe");
    expect(verifyDeliveryScript).not.toContain("$env:LOCALAPPDATA\\WonRemote Viewer");
  });

  it("shows OS architecture in the Windows registry diagnostic script", () => {
    const registryStatusScript = readFileSync(path.join(projectRoot, "scripts", "check-registry-status.bat"), "utf8");

    expect(registryStatusScript).toContain("wmic os get OSArchitecture");
    expect(registryStatusScript).toContain("OSArchitecture:");
    expect(registryStatusScript).toContain("supports 32-bit and 64-bit Windows");
  });

  it("enforces the two-installer product-isolated x86 release contract", () => {
    const packageReleaseScript = readFileSync(path.join(projectRoot, "scripts", "package-release-exes.js"), "utf8");
    const publishScript = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    const manifestScript = readFileSync(path.join(projectRoot, "scripts", "create-update-manifest.js"), "utf8");
    for (const asset of [
      "WonRemote-Viewer-Setup.exe",
      "WonRemote-Agent-Setup.exe",
    ]) {
      expect(publishScript).toContain(asset);
    }
    expect(packageReleaseScript).toContain("expectedOutputs");
    expect(packageReleaseScript).toContain("Two x86 WonRemote product installers created");
    expect(publishScript).toContain("Publish-Asset $ManifestPath $ManifestName");
    expect(publishScript.match(/^\s{2}Publish-Asset /gm)?.length).toBe(3);
    expect(publishScript).toContain("Refusing to replace published release");
    expect(publishScript).toContain("Bump the version before publishing");
    expect(publishScript).toContain("Release upload verification failed");
    expect(publishScript).toContain('$ReleaseList = Invoke-GitHubJson "Get" "${ReleaseApi}?per_page=100"');
    expect(publishScript).toContain("$PublishedAssets = @(");
    expect(publishScript).toContain("return Invoke-RestMethod -Method Post");
    expect(publishScript).toContain("size differs from the local signed asset");
    expect(publishScript).toContain("Release download verification failed");
    expect(publishScript).toContain("verify-release-manifest.js");
    expect(manifestScript).toContain("viewerWindows");
    expect(manifestScript).toContain("agentWindows");
    expect(manifestScript).toContain("release-tag");
    expect(manifestScript).not.toContain("latest/download");
    expect(packageReleaseScript).not.toContain("WONREMOTE_RESTART_MODE");
    expect(packageReleaseScript).toContain("copyStableX86Installers");
  });

  it("builds releases from gated main commits so release caches remain reusable", () => {
    const releaseWorkflow = readFileSync(path.join(projectRoot, "..", ".github", "workflows", "publish-release.yml"), "utf8");

    expect(releaseWorkflow).toContain('branches: ["main"]');
    expect(releaseWorkflow).not.toContain('tags: ["v*"]');
    expect(releaseWorkflow).toContain("startsWith(github.event.head_commit.message, 'Prepare WonRemote v')");
    expect(releaseWorkflow).toContain('require("./CHANGE_CONTRACT.json")');
    expect(releaseWorkflow).toContain('c.status === "ready-to-deploy"');
    expect(releaseWorkflow).toContain('["deploy", "build-and-deploy"].includes(c.releaseImpact)');
    expect(releaseWorkflow).toContain('$DEPLOYMENT_STAGE" == "predeploy"');
    expect(releaseWorkflow).toContain("verify-recurrence-coverage.js --stage predeploy");
    expect(releaseWorkflow).toContain("npm run change:verify:predeploy");
    expect(releaseWorkflow).toContain('$env:GITHUB_REF_TYPE -ne "branch" -or $env:GITHUB_REF_NAME -ne "main"');
    expect(releaseWorkflow).toContain("src/agent/productionInstallerUpdate.test.ts");
    expect(releaseWorkflow).toContain("src/agent/agentUpdateOnce.test.ts");
    expect(releaseWorkflow).toContain("src/agent/productionUpdateMetadata.test.ts");
    expect(releaseWorkflow).toContain("src/domain/updateManifestScript.test.ts");
    expect(releaseWorkflow).toContain("test_update_handoff_acknowledgement_path_is_adjacent_to_the_owned_script");
    expect(releaseWorkflow).toContain("actions/cache/restore@v4");
    expect(releaseWorkflow).toContain("actions/cache/save@v4");
    expect(releaseWorkflow).toContain("build-release:");
    expect(releaseWorkflow).toContain("publish-release:");
    expect(releaseWorkflow).toContain("needs: build-release");
    expect(releaseWorkflow).toContain("actions/upload-artifact@v4");
    expect(releaseWorkflow).toContain("actions/download-artifact@v4");
    expect(releaseWorkflow).toContain('WONREMOTE_SKIP_BUILD_PAYLOAD_PREFLIGHT: "YES"');
    expect(releaseWorkflow).toContain("name: wonremote-release-${{ github.sha }}");
    expect(releaseWorkflow).toContain("aether-link-app/.local-run/node-runtimes");
    expect(releaseWorkflow).toContain("aether-link-app/.local-run/cmake");
    expect(releaseWorkflow).toContain("aether-link-app/.local-run/nasm");
    expect(releaseWorkflow).not.toContain("aether-link-app/.cache");
    expect(releaseWorkflow).toContain("Verify live Firebase download aliases");
    expect(releaseWorkflow).toContain("--max-redirs 0");
    expect(releaseWorkflow).toContain('"viewer-x86" = "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Setup.exe"');
    expect(releaseWorkflow).toContain('"agent-x86" = "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Agent-Setup.exe"');
  });

  it("does not require Authenticode until the release certificate is provisioned", () => {
    const releaseWorkflow = readFileSync(path.join(projectRoot, "..", ".github", "workflows", "publish-release.yml"), "utf8");

    expect(releaseWorkflow).toContain("WONREMOTE_REQUIRE_AUTHENTICODE: ${{ vars.WONREMOTE_REQUIRE_AUTHENTICODE }}");
    expect(releaseWorkflow).not.toContain('WONREMOTE_REQUIRE_AUTHENTICODE: "YES"');
    expect(releaseWorkflow.indexOf("run: npm run release:sign")).toBeGreaterThan(
      releaseWorkflow.indexOf("run: npm run release:exes"),
    );
    expect(releaseWorkflow.indexOf("run: npm run release:manifest")).toBeGreaterThan(
      releaseWorkflow.indexOf("run: npm run release:sign"),
    );
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

  it("checks installed Viewer updates natively but installs only after WebView confirmation", () => {
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

    expect(tauriLib).not.toContain("fn start_viewer_update_watcher");
    expect(viewerModeSetup).not.toContain("start_installer_update(");
    expect(agentModeSetup).not.toContain("start_viewer_update_watcher");
    expect(tauriLib).toContain("restart_viewer_from_tray(app)");
    expect(tauriLib).toContain('.env("WONREMOTE_UPDATE_PRODUCT", restart_mode)');
    expect(tauriLib).toContain('.env("WONREMOTE_TAURI_UPDATE_BROKER", "1")');
    expect(tauriLib).toContain("launch_brokered_update_handoff");
    expect(tauriLib).toContain("fn check_installer_update");
    expect(tauriLib).toContain("fn check_agent_installer_update");
    expect(tauriLib).toContain("check_installer_update,");
    expect(tauriLib).toContain("check_agent_installer_update,");
    const manualCheck = appTsx.slice(
      appTsx.indexOf("const handleManualViewerUpdate"),
      appTsx.indexOf("const handleConfirmViewerUpdate"),
    );
    const nativeBranch = manualCheck.slice(
      manualCheck.indexOf("(window as any).__TAURI_INTERNALS__"),
      manualCheck.indexOf(": await fetchViewerUpdateMetadata"),
    );
    expect(nativeBranch).toContain('invoke<{ available: boolean; latestVersion: string }>("check_installer_update")');
    expect(appTsx).toContain('invoke<{ available: boolean; latestVersion: string }>("check_agent_installer_update")');
    expect(appTsx).toContain('invoke("start_installer_update", { restartMode: "agent" })');
    expect(nativeBranch).not.toContain("fetchViewerUpdateMetadata");
    expect(nativeBranch).not.toContain("github.com");
    expect(appTsx).toContain("const checkNativeViewerUpdate");
    expect(appTsx).toContain('invoke("start_installer_update", { restartMode: "viewer" })');
    expect(appTsx).toContain("the WebView owns user consent");
    expect(appTsx).toContain('const title = isAvailable ? "최신 업데이트가 있습니다"');
    expect(appTsx).toContain("`${state.version} 버전 업데이트를 진행합니다.`");
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

  it("passes one release ICE configuration to both Viewer and packaged Agent", () => {
    const workflow = readFileSync(
      path.join(projectRoot, "..", ".github", "workflows", "publish-release.yml"),
      "utf8",
    );
    const buildScript = readFileSync(path.join(projectRoot, "src-tauri", "build.rs"), "utf8");
    const tauriLib = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");
    const rtcKeys = [
      "RTC_STUN_URLS",
      "RTC_TURN_URLS",
      "RTC_TURN_USERNAME",
      "RTC_TURN_CREDENTIAL",
      "RTC_RELAY_ONLY",
      "RTC_CONNECT_TIMEOUT_MS",
    ];

    for (const suffix of rtcKeys) {
      expect(workflow).toContain(`VITE_WONREMOTE_${suffix}:`);
      expect(buildScript).toContain(`"VITE_WONREMOTE_${suffix}"`);
      expect(tauriLib).toContain(`option_env!("VITE_WONREMOTE_${suffix}")`);
      expect(tauriLib).toContain(`"WONREMOTE_${suffix}"`);
    }
    const agentSpawn = tauriLib.slice(
      tauriLib.indexOf("fn spawn_agent_only_process"),
      tauriLib.indexOf("fn start_agent_watchdog"),
    );
    const rtcEnv = tauriLib.slice(
      tauriLib.indexOf("fn apply_rtc_env"),
      tauriLib.indexOf("fn local_api_addr"),
    );
    expect(agentSpawn).toContain("apply_firebase_env(&mut command);");
    expect(agentSpawn).toContain("apply_rtc_env(&mut command);");
    expect(rtcEnv).toContain("command.env_remove(key);");
    expect(rtcEnv).not.toContain("env::var(");
    expect(workflow).toContain("TURN URL, username, and credential must be configured together.");
    expect(workflow).toContain("Relay-only release requires a complete TURN configuration.");
  });
});
