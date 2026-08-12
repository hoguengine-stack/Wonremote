import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_HANDOFF_CREATION_FLAGS,
  prepareInstallerHandoff,
  downloadInstallerUpdate,
  installerArgsForUpdate,
  isInstallerUpdateMetadata,
} from "./productionInstallerUpdate";

describe("production installer update", () => {
  it("downloads a verified installer asset into the WonRemote update directory", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-installer-update-${process.pid}-${Date.now()}`);
    const body = Buffer.from("installer-binary");
    const checksum = createHash("sha256").update(body).digest("hex");

    try {
      await mkdir(baseDir, { recursive: true });
      const result = await downloadInstallerUpdate(
        {
          assetName: "../WonRemote Viewer_0.1.9_x64-setup.exe",
          checksum,
          downloadUrl: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.9/WonRemote.exe",
          latestVersion: "0.1.9",
          updateKind: "installer",
        },
        {
          baseDir,
          fetchImpl: async () =>
            new Response(body, {
              status: 200,
            }),
        },
      );

      expect(path.dirname(result.installerPath)).toBe(path.join(baseDir, "WonRemote", "updates"));
      expect(path.basename(result.installerPath)).toMatch(
        /^WonRemote Viewer_0\.1\.9_x64-setup-[0-9a-f]{8}-[0-9a-f-]{27}\.exe$/,
      );
      expect(await readFile(result.installerPath)).toEqual(body);
      expect(result.installerArgs).toEqual(["/S"]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("rejects installer assets whose SHA-256 does not match the manifest", async () => {
    await expect(
      downloadInstallerUpdate(
        {
          checksum: "0".repeat(64),
          downloadUrl: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.9/WonRemote.exe",
          latestVersion: "0.1.9",
          updateKind: "installer",
        },
        {
          baseDir: os.tmpdir(),
          fetchImpl: async () => new Response(Buffer.from("tampered"), { status: 200 }),
        },
      ),
    ).rejects.toThrow("Installer checksum mismatch");
  });

  it("recognizes only complete installer update metadata", () => {
    expect(
      isInstallerUpdateMetadata({
        checksum: "1".repeat(64),
        downloadUrl: "https://example.com/WonRemote.exe",
        latestVersion: "0.1.9",
        updateKind: "installer",
      }),
    ).toBe(true);
    expect(isInstallerUpdateMetadata({ updateKind: "source-tree" })).toBe(false);
    expect(installerArgsForUpdate({ installerArgs: ["/S", "/D=C:\\WonRemote"] })).toEqual(["/S", "/D=C:\\WonRemote"]);
    expect(installerArgsForUpdate({ installerArgs: ["", 12, "/S"] })).toEqual(["/S"]);
  });

  it("prepares a detached PowerShell handoff script that can break away from the Tauri job object", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-installer-handoff-${process.pid}-${Date.now()}`);
    const installerPath = path.join(baseDir, "WonRemote", "updates", "WonRemote-Viewer-Agent-Setup.exe");

    try {
      await mkdir(path.dirname(installerPath), { recursive: true });
      await writeFile(installerPath, "installer");

      const result = await prepareInstallerHandoff(
        {
          installerArgs: ["/S", "/D=C:\\Users\\Tester\\WonRemote Agent"],
          installerPath,
        },
        { baseDir },
      );

      const script = await readFile(result.scriptPath, "utf8");
      expect(result.command).toBe("powershell.exe");
      expect(result.args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", result.scriptPath]);
      expect(result.creationFlags).toBe(INSTALLER_HANDOFF_CREATION_FLAGS);
      expect(path.dirname(result.logPath)).toBe(path.join(baseDir, "WonRemote", "updates"));
      expect(path.basename(result.logPath)).toMatch(/^installer-handoff-[0-9a-f-]{36}\.log$/);
      expect(script).toContain("Start-Process -FilePath");
      expect(script).toContain("WaitForExit()");
      expect(script).toContain("Installer exit code");
      expect(script).toContain("WonRemote-Viewer-Agent-Setup.exe");
      expect(script).toContain("/D=C:\\Users\\Tester\\WonRemote Agent");
      expect(script).toContain("$explicitInstallRoots = @('C:\\Users\\Tester\\WonRemote Agent')");
      expect(script).toContain("Get-CimInstance Win32_Process");
      expect(script).toContain("Test-UnderPath $_.ExecutablePath $roots");
      expect(script).toContain("Normalize-PathForCompare");
      expect(script).toContain("Convert-ExtendedPath");
      expect(script).toContain("$extendedUncPrefix");
      expect(script).toContain("$candidatePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)");
      expect(script).toContain("$rootPrefix = \"$rootPath$([System.IO.Path]::DirectorySeparatorChar)\"");
      expect(script).toContain("Stop-Process -Id $target.ProcessId -Force");
      expect(script).not.toContain("Get-Process node");
      expect(script).not.toContain("taskkill");
      expect(script).toContain("Another WonRemote update is already in progress");
      expect(script).toContain("[System.IO.FileShare]::None");
      expect(script).toContain("Remove-Item Env:WONREMOTE_RESTART_MODE -ErrorAction SilentlyContinue");
      expect(script).toContain("Start-WonRemoteAgent");
      expect(script).toContain("Join-Path $root \"wonremote-viewer.exe\"");
      expect(script).toContain("Test-WonRemoteAgentRunning");
      expect(script).toContain("WonRemote Agent is already running after installer exit; skipping fallback start.");
      expect(script).toContain("Wait-WonRemoteAgentRuntime");
      expect(script).toContain("agent/index.mjs --watch runtime did not stay alive");
      expect(script).toContain("(?i)[\\\\/]agent[\\\\/]index\\.mjs");
      expect(script).toContain("(?i)(^|\\s)--watch(\\s|$)");
      expect(script).toContain("Start-Process -FilePath $candidate -ArgumentList @('--agent') -WindowStyle Hidden");
      expect(script).toContain("if ($process.ExitCode -eq 0) {\n    Start-WonRemoteAgent\n    if ($RestartMode -eq 'agent') {\n      Wait-WonRemoteAgentRuntime");
      const second = await prepareInstallerHandoff(
        { installerArgs: ["/S"], installerPath },
        { baseDir },
      );
      expect(second.scriptPath).not.toBe(result.scriptPath);
      expect(second.logPath).not.toBe(result.logPath);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("restarts the interactive Viewer after a viewer-mode installer handoff", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-viewer-handoff-${process.pid}-${Date.now()}`);
    const installerPath = path.join(baseDir, "WonRemote", "updates", "WonRemote-Viewer-Agent-Setup.exe");

    try {
      await mkdir(path.dirname(installerPath), { recursive: true });
      await writeFile(installerPath, "installer");
      const result = await prepareInstallerHandoff(
        { installerArgs: ["/S"], installerPath },
        { baseDir, restartMode: "viewer" },
      );
      const script = await readFile(result.scriptPath, "utf8");

      expect(script).toContain("function Start-WonRemoteViewer");
      expect(script).toContain('Start-Process -FilePath $candidate\n');
      expect(script).toContain("if ($process.ExitCode -eq 0) {\n    Start-WonRemoteViewer\n    if ($RestartMode -eq 'agent') {");
      expect(script).toContain("} else {\n      Wait-WonRemoteViewer\n    }");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("uses the exact product restart executable path before legacy install-path discovery", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-explicit-restart-${process.pid}-${Date.now()}`);
    const installerPath = path.join(baseDir, "WonRemote", "updates", "installer.exe");
    const restartExecutablePath = path.join(baseDir, "custom", "WonRemote Viewer.exe");
    try {
      await mkdir(path.dirname(installerPath), { recursive: true });
      await writeFile(installerPath, "installer");
      const result = await prepareInstallerHandoff(
        { installerArgs: ["/S"], installerPath },
        { baseDir, restartMode: "viewer", restartExecutablePath } as any,
      );
      const script = await readFile(result.scriptPath, "utf8");
      expect(script).toContain(restartExecutablePath);
      expect(script).toContain("Start-Process -FilePath $RestartExecutablePath");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
