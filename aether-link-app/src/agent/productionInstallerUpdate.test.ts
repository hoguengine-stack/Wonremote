import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_HANDOFF_CREATION_FLAGS,
  cleanupInstallerUpdateArtifacts,
  prepareInstallerHandoff,
  downloadInstallerUpdate,
  installerArgsForUpdate,
  isInstallerUpdateMetadata,
} from "./productionInstallerUpdate";

describe("production installer update", () => {
  it.runIf(process.platform === "win32").each(["launch", "installer", "runtime"])(
    "preserves or restores the runtime at the %s failure boundary",
    async (failure) => {
      const baseDir = path.join(os.tmpdir(), `wonremote-failure-${process.pid}-${failure}-${Date.now()}`);
      try {
        await mkdir(baseDir, { recursive: true });
        const handoff = await prepareInstallerHandoff({
          installerPath: path.join(baseDir, "installer.exe"), installerArgs: ["/S"],
        }, { baseDir });
        const script = await readFile(handoff.scriptPath, "utf8");
        const start = script.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall");
        expect(start).toBeGreaterThan(0);
        const events = path.join(baseDir, "events.txt");
        const harness = path.join(baseDir, "failure.ps1");
        await writeFile(harness, `
$ErrorActionPreference = 'Stop'
$FailureExitCode = 1
$InstallerStarted = $false
$RestartMode = 'agent'
function Record([string]$Event) { Add-Content -LiteralPath $env:WR_EVENTS -Value $Event }
function Backup-WonRemoteInstall { $script:RollbackEntries = @('backup'); Record 'backup' }
function Write-HandoffLog([string]$Message) {}
function Start-Process {
  Record 'launch'
  if ($env:WR_FAILURE -eq 'launch') { throw 'installer launch rejected' }
  $p = [pscustomobject]@{ Id = 1; ExitCode = $(if ($env:WR_FAILURE -eq 'installer') { 5 } else { 0 }) }
  $p | Add-Member ScriptMethod WaitForExit { }
  return $p
}
function Start-WonRemoteAgent { Record 'start' }
function Wait-WonRemoteAgentRuntime { Record 'health'; throw 'replacement runtime unavailable' }
function Restore-WonRemoteInstall { Record 'restore-and-restart' }
function Remove-WonRemoteRollback { Record 'cleanup-backup' }
function Write-UpdateResult([string]$State, [string]$Message) { Record $State }
function Close-UpdateLock { Record 'unlock' }
${script.slice(start)}
`);
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
          env: { ...process.env, WR_EVENTS: events, WR_FAILURE: failure }, encoding: "utf8", timeout: 20_000, windowsHide: true,
        });
        expect(result.status, result.stderr).toBe(failure === "installer" ? 5 : 1);
        const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/);
        if (failure === "launch") {
          expect(recorded).toEqual(["backup", "launch", "failed", "cleanup-backup", "unlock"]);
          await expect(stat(`${harness}.accepted`)).rejects.toThrow();
        } else {
          expect(recorded).toEqual([
            "backup", "launch", ...(failure === "runtime" ? ["start", "health"] : []),
            "restore-and-restart", "rollback", "cleanup-backup", "unlock",
          ]);
        }
      } finally { await rm(baseDir, { recursive: true, force: true }); }
    },
    30_000,
  );
  it.runIf(process.platform === "win32")("executes successful handoff cleanup without deleting failure evidence or identity", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-cleanup-${process.pid}-${Date.now()}`);
    const updates = path.join(baseDir, "WonRemote", "updates");
    await mkdir(updates, { recursive: true });
    const installer = path.join(updates, "current.exe");
    try {
      const handoff = await prepareInstallerHandoff({ installerPath: installer, installerArgs: ["/S"] }, { baseDir });
      const script = await readFile(handoff.scriptPath, "utf8");
      const start = script.indexOf("  Remove-Item", script.indexOf("Write-UpdateResult 'healthy' ''"));
      const end = script.indexOf("  Close-UpdateLock", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const artifacts = [installer, `${installer}.part`, `${handoff.scriptPath}.accepted`];
      for (const file of artifacts) await writeFile(file, "temporary");
      const retained = path.join(updates, "failed-installer.exe");
      const identity = path.join(baseDir, "agent-config.json");
      await writeFile(retained, "failure evidence");
      await writeFile(identity, "identity");
      const harness = path.join(baseDir, "cleanup-test.ps1");
      await writeFile(harness, "$InstallerPath=$env:WR_TEST_INSTALLER\n$PSCommandPath=$env:WR_TEST_HANDOFF\n" + script.slice(start, end));
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
        env: { ...process.env, WR_TEST_INSTALLER: installer, WR_TEST_HANDOFF: handoff.scriptPath }, encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
      for (const file of [...artifacts, handoff.scriptPath]) await expect(stat(file)).rejects.toThrow();
      expect(await readFile(retained, "utf8")).toBe("failure evidence");
      expect(await readFile(identity, "utf8")).toBe("identity");
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });
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
      expect(path.basename(result.installerPath)).toBe(
        `WonRemote Viewer_0.1.9_x64-setup-${checksum.slice(0, 12)}.exe`,
      );
      expect(await readFile(result.installerPath)).toEqual(body);
      expect(result.installerArgs).toEqual(["/S"]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("resumes a partial installer download with an HTTP Range request", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-installer-resume-${process.pid}-${Date.now()}`);
    const body = Buffer.from("complete-installer-binary");
    const checksum = createHash("sha256").update(body).digest("hex");
    const updatesDir = path.join(baseDir, "WonRemote", "updates");
    const installerPath = path.join(updatesDir, `WonRemote-Agent-Setup-${checksum.slice(0, 12)}.exe`);
    const partialPath = `${installerPath}.part`;
    const firstPart = body.subarray(0, 9);
    const requestedRanges: Array<string | null> = [];

    try {
      await mkdir(updatesDir, { recursive: true });
      await writeFile(partialPath, firstPart);
      const result = await downloadInstallerUpdate(
        {
          assetName: "WonRemote-Agent-Setup.exe",
          checksum,
          downloadUrl: "https://example.com/WonRemote-Agent-Setup.exe",
          latestVersion: "0.1.9",
          updateKind: "installer",
        },
        {
          baseDir,
          fetchImpl: async (_url, init) => {
            const range = new Headers(init?.headers).get("Range");
            requestedRanges.push(range);
            return new Response(body.subarray(firstPart.length), {
              headers: {
                "content-length": String(body.length - firstPart.length),
                "content-range": `bytes ${firstPart.length}-${body.length - 1}/${body.length}`,
              },
              status: 206,
            });
          },
        },
      );

      expect(requestedRanges).toEqual([`bytes=${firstPart.length}-`]);
      expect(result.installerPath).toBe(installerPath);
      expect(await readFile(installerPath)).toEqual(body);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("cleans stale update artifacts but retains rollback-failure backups", async () => {
    const updatesDir = path.join(os.tmpdir(), `wonremote-installer-cleanup-${process.pid}-${Date.now()}`);
    const staleInstaller = path.join(updatesDir, "old-installer.exe");
    const staleRollback = path.join(updatesDir, "rollback-stale");
    const failedRollback = path.join(updatesDir, "rollback-failed");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    try {
      await mkdir(staleRollback, { recursive: true });
      await mkdir(failedRollback, { recursive: true });
      await writeFile(staleInstaller, "old");
      await writeFile(path.join(failedRollback, "ROLLBACK_FAILED"), "retain");
      await Promise.all([
        utimes(staleInstaller, old, old),
        utimes(staleRollback, old, old),
        utimes(failedRollback, old, old),
      ]);

      await cleanupInstallerUpdateArtifacts(updatesDir);

      await expect(readFile(staleInstaller)).rejects.toThrow();
      await expect(stat(staleRollback)).rejects.toThrow();
      expect(await readFile(path.join(failedRollback, "ROLLBACK_FAILED"), "utf8")).toBe("retain");
    } finally {
      await rm(updatesDir, { recursive: true, force: true });
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
      expect(script).toContain("function Backup-WonRemoteInstall");
      expect(script).toContain("function Restore-WonRemoteInstall");
      expect(script).toContain("Backed up WonRemote install root");
      expect(script).toContain("Restored WonRemote install root");
      expect(script).toContain("WonRemote installer rollback completed and previous runtime recovered.");
      expect(script).toContain("Installer rollback failed");
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
      const handoffStart = script.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall");
      const installerLaunch = script.indexOf("$process = Start-Process", handoffStart);
      expect(handoffStart).toBeGreaterThanOrEqual(0);
      expect(installerLaunch).toBeGreaterThan(handoffStart);
      expect(script.slice(handoffStart, installerLaunch)).not.toContain("Stop-WonRemoteProcesses");
      expect(script.slice(handoffStart, installerLaunch)).toContain("Keep the current Agent alive while Windows approval is pending.");
      if (process.platform === "win32") {
        const launchEnd = script.indexOf("\n  Write-HandoffLog \"Installer PID", installerLaunch);
        const executablePrefix = script.slice(
          script.indexOf("  Backup-WonRemoteInstall", handoffStart),
          launchEnd,
        );
        const sequenceProbe = [
          "$events = [Collections.Generic.List[string]]::new()",
          "function Backup-WonRemoteInstall { [void]$events.Add('backup') }",
          "function Stop-WonRemoteProcesses { [void]$events.Add('stop') }",
          "function Write-HandoffLog { param([string]$Message) }",
          "function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru); [void]$events.Add('launch'); return [pscustomobject]@{Id=4321} }",
          "function Set-Content { param($LiteralPath,$Encoding,$Value); [void]$events.Add('ready') }",
          "$InstallerPath = 'installer.exe'",
          "$InstallerArgs = @('/S')",
          executablePrefix,
          "Write-Output ($events -join ',')",
        ].join("\n");
        const sequence = spawnSync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(sequenceProbe, "utf16le").toString("base64"),
        ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
        expect(sequence.status, sequence.stderr).toBe(0);
        expect(sequence.stdout.trim()).toBe("backup,launch,ready");
      }
      const readinessSignal = script.indexOf("Set-Content -LiteralPath ($PSCommandPath + '.accepted')", installerLaunch);
      expect(readinessSignal).toBeGreaterThan(installerLaunch);
      expect(readinessSignal).toBeLessThan(script.indexOf("$process.WaitForExit()", installerLaunch));
      expect(script).toContain("throw 'No previous WonRemote installation was available to back up.'");
      const prelaunchFailure = script.indexOf("if (-not $InstallerStarted)", readinessSignal);
      expect(prelaunchFailure).toBeGreaterThan(readinessSignal);
      const prelaunchFailureEnd = script.indexOf("$rollbackCompleted = $false", prelaunchFailure);
      const prelaunchFailureBranch = script.slice(prelaunchFailure, prelaunchFailureEnd);
      expect(prelaunchFailureBranch).toContain("existing runtime preserved");
      expect(prelaunchFailureBranch).toContain("Remove-WonRemoteRollback");
      expect(prelaunchFailureBranch).toContain("Close-UpdateLock");
      expect(prelaunchFailureBranch).not.toContain("Restore-WonRemoteInstall");
      expect(prelaunchFailureBranch).not.toContain(".accepted");
      expect(script).toContain("Rollback backup retained for manual recovery");
      expect(script).toContain("ROLLBACK_FAILED");
      expect(script).toContain("last-update-result.json");
      expect(script).toContain("Write-UpdateResult 'healthy'");
      expect(script).toContain("Write-UpdateResult 'rollback'");
      expect(script).toContain("Write-UpdateResult 'failed'");
      expect(script).toContain("Remove-WonRemoteRollback\n  Write-UpdateResult 'healthy' ''\n  Remove-Item");
      expect(script).not.toContain("WONREMOTE_RESTART_MODE");
      expect(script).toContain("Start-WonRemoteAgent");
      expect(script).toContain("Join-Path $root \"wonremote-viewer.exe\"");
      expect(script).toContain("Test-WonRemoteAgentRunning");
      expect(script).toContain("WonRemote Agent is already running after installer exit; skipping fallback start.");
      expect(script).toContain("Wait-WonRemoteAgentRuntime");
      expect(script).toContain("agent/index.mjs --watch runtime did not stay alive");
      expect(script).toContain("(?i)[\\\\/]agent[\\\\/]index\\.mjs");
      expect(script).toContain("(?i)(^|\\s)--watch(\\s|$)");
      expect(script).toContain("Start-Process -FilePath $candidate -ArgumentList @('--agent') -WindowStyle Hidden");
      expect(script).toContain("if ($process.ExitCode -ne 0) {");
      expect(script).toContain("Start-WonRemoteAgent\n  if ($RestartMode -eq 'agent') {\n    Wait-WonRemoteAgentRuntime");
      expect(script).toContain("catch {\n  Write-HandoffLog \"Installer handoff failed");
      expect(script).toContain("Restore-WonRemoteInstall");
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
      expect(script).toContain("Start-WonRemoteViewer\n  if ($RestartMode -eq 'agent') {");
      expect(script).toContain("} else {\n    Wait-WonRemoteViewer\n  }");
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
