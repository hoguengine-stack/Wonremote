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

const POWERSHELL_HARNESS_TIMEOUT_MS = 60_000;
const POWERSHELL_CASE_TIMEOUT_MS = 75_000;

describe("production installer update", () => {
  it.runIf(process.platform === "win32").each([false, true])("retains or recovers the Agent when a real Windows file lock interrupts rollback (missing Agent: %s)", async (missingAgent) => {
    const baseDir = path.join(os.tmpdir(), `wonremote-locked-rollback-${process.pid}-${Date.now()}`);
    try {
      const root = path.join(baseDir, "installed");
      const backup = path.join(baseDir, "backup");
      for (const directory of [root, backup]) {
        await mkdir(path.join(directory, "agent"), { recursive: true });
        await mkdir(path.join(directory, "bin"), { recursive: true });
        if (directory === backup || !missingAgent) {
          await writeFile(path.join(directory, "agent", "index.mjs"), directory === root ? "replacement-agent" : "retained-agent");
        }
        await writeFile(path.join(directory, "bin", "capture.exe"), directory === root ? "replacement" : "previous");
      }
      await mkdir(path.join(root, ".update-handoff"), { recursive: true });
      await mkdir(path.join(backup, "empty", "nested"), { recursive: true });
      await writeFile(path.join(root, ".update-handoff", "alive.txt"), "handoff");
      await mkdir(path.join(root, "obsolete", "nested"), { recursive: true });
      await writeFile(path.join(root, "obsolete", "nested", "new-only.dll"), "obsolete");
      const installer = path.join(baseDir, "installer.exe");
      await writeFile(installer, "fixture");
      const handoff = await prepareInstallerHandoff({ installerPath: installer, installerArgs: ["/S"],
        installerSha256: createHash("sha256").update("fixture").digest("hex") }, { baseDir });
      const source = await readFile(handoff.scriptPath, "utf8");
      const prefix = source.slice(0, source.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall"));
      const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const harness = path.join(baseDir, "locked.ps1");
      await writeFile(harness, prefix + `
$RestartMode='viewer'
$root=${q(root)}
$backup=${q(backup)}
$script:RollbackEntries=@([pscustomobject]@{Root=$root;Backup=$backup})
function Stop-WonRemoteProcesses {}
$script:starts=0
function Start-WonRemoteAgent { $script:starts++ }
function Wait-WonRemoteViewer {}
$locked=[IO.File]::Open((Join-Path $root 'bin\\capture.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$rejected=$false
try { Restore-WonRemoteInstall } catch { $rejected=$true } finally { $locked.Dispose() }
if (-not $rejected) { throw 'Locked file was not rejected' }
if ($script:starts -ne 0) { throw 'Failed rollback restarted an incomplete runtime' }
$agentPath=Join-Path $root 'agent\\index.mjs'
if (${missingAgent ? "$true" : "$false"}) {
  if (Test-Path -LiteralPath $agentPath) { throw 'Rollback added Agent before checking the late lock' }
} elseif ((Get-Content -LiteralPath $agentPath -Raw) -ne 'replacement-agent') {
  throw 'Rollback replaced an earlier file before checking the late lock'
}
if ((Get-Content -LiteralPath (Join-Path $root 'bin\\capture.exe') -Raw) -ne 'replacement') { throw 'Locked target was corrupted' }
if (-not (Test-Path -LiteralPath (Join-Path $backup 'agent\\index.mjs'))) { throw 'Recovery backup lost' }
Restore-WonRemoteInstall
if ($script:starts -ne 1) { throw 'Successful restore did not restart exactly once' }
if ((Get-Content -LiteralPath (Join-Path $root 'bin\\capture.exe') -Raw) -ne 'previous') { throw 'Retry did not restore previous version' }
if (Test-Path -LiteralPath (Join-Path $root 'obsolete')) { throw 'Obsolete payload retained after successful restore' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'empty\\nested') -PathType Container)) { throw 'Empty backup directory not restored' }
if (-not (Test-Path -LiteralPath (Join-Path $root '.update-handoff\\alive.txt'))) { throw 'Independent updater deleted' }
if (@(Get-ChildItem -LiteralPath $root -Recurse -Filter '*.rollback-tmp').Count -ne 0) { throw 'Temporary rollback files leaked' }
$capturePath=Join-Path $root 'bin\\capture.exe'
[IO.File]::WriteAllText($agentPath,'candidate-agent')
[IO.File]::WriteAllText($capturePath,'candidate-capture')
$script:copyCommand=Get-Command Copy-Item -CommandType Cmdlet
$script:raceLock=$null
function Copy-Item {
  param([string]$LiteralPath,[string]$Destination,[switch]$Force)
  if ($Destination.StartsWith($capturePath + '.') -and $Destination.EndsWith('.rollback-tmp')) {
    if ((Get-Content -LiteralPath $agentPath -Raw) -ne 'retained-agent') { throw 'Test did not reach a later replacement' }
    $script:raceLock=[IO.File]::Open($capturePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  }
  & $script:copyCommand -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
$rejected=$false
try { Restore-WonRemoteInstall } catch { $rejected=$true } finally {
  Remove-Item Function:\\Copy-Item
  if ($script:raceLock) { $script:raceLock.Dispose() }
}
if (-not $rejected -or -not $script:raceLock -or $script:starts -ne 1) { throw 'Post-preflight lock did not reject a partial restore' }
if ((Get-Content -LiteralPath $agentPath -Raw) -ne 'candidate-agent' -or
    (Get-Content -LiteralPath $capturePath -Raw) -ne 'candidate-capture') { throw 'Post-preflight lock did not undo the earlier replacement' }
[IO.File]::WriteAllText($capturePath,'previous')
$locked=[IO.File]::Open($capturePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  Restore-WonRemoteInstall
  if ($script:starts -ne 2 -or (Get-Content -LiteralPath $agentPath -Raw) -ne 'retained-agent') {
    throw 'A byte-identical locked capture file prevented recovery'
  }
} finally { $locked.Dispose() }
$empty=Join-Path (Split-Path -Parent $backup) 'empty-backup'
New-Item -ItemType Directory -Path $empty | Out-Null
foreach ($invalidBackup in @($empty, (Join-Path $empty 'missing'))) {
  $script:RollbackEntries=@([pscustomobject]@{Root=$root;Backup=$invalidBackup})
  $rejected=$false
  try { Restore-WonRemoteInstall } catch { $rejected=$true }
  if (-not $rejected) { throw 'Invalid backup was accepted' }
  if ((Get-Content -LiteralPath (Join-Path $root 'agent\\index.mjs') -Raw) -ne 'retained-agent') { throw 'Invalid backup damaged runtime' }
}
Close-UpdateLock
'locked-rollback-preserved-and-retried'
`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", harness], {
        encoding: "utf8", windowsHide: true, timeout: 15000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("locked-rollback-preserved-and-retried");
    } finally {
      expect(path.dirname(path.resolve(baseDir))).toBe(path.resolve(os.tmpdir()));
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 20000);
  it.runIf(process.platform === "win32")("accepts a slow runtime after fifteen seconds but still enforces a bounded readiness deadline", async () => {
    const baseDir=path.join(os.tmpdir(),`wonremote-slow-runtime-${process.pid}-${Date.now()}`);
    await mkdir(baseDir,{recursive:true});
    try {
      const installer=path.join(baseDir,"installer.exe");await writeFile(installer,"fixture");
      const handoff=await prepareInstallerHandoff({installerPath:installer,installerArgs:["/S"],installerSha256:createHash("sha256").update("fixture").digest("hex")},{baseDir});
      const source=await readFile(handoff.scriptPath,"utf8");
      const prefix=source.slice(0,source.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall"));
      const harness=path.join(baseDir,"slow.ps1");
      await writeFile(harness,prefix+`
$global:clock=[datetime]'2026-11-03T00:00:00Z'
$global:origin=$global:clock
function Get-Date { $global:clock }
function Start-Sleep {param($Milliseconds);$global:clock=$global:clock.AddMilliseconds($Milliseconds)}
function Test-WonRemoteAgentRuntime { ($global:clock-$global:origin).TotalSeconds -ge 18 }
Wait-WonRemoteAgentRuntime
if(($global:clock-$global:origin).TotalSeconds -lt 18){throw 'Readiness skipped'}
$global:origin=$global:clock
function Test-WonRemoteAgentRuntime { $false }
$rejected=$false
try{Wait-WonRemoteAgentRuntime}catch{$rejected=$true}
if(-not $rejected -or ($global:clock-$global:origin).TotalSeconds -gt 61){throw 'Unbounded or missing runtime wait'}
Close-UpdateLock
'slow-ready-and-bounded'
`);
      const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",harness],{windowsHide:true,encoding:"utf8",timeout:15000});
      expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain("slow-ready-and-bounded");
    }finally{await rm(baseDir,{recursive:true,force:true});}
  },20000);
  it.runIf(process.platform === "win32").each(["launch", "installer", "locked-log", "locked-result", "runtime", "online", "rollback"])(
    "preserves or restores the runtime at the %s failure boundary",
    async (failure) => {
      const baseDir = path.join(os.tmpdir(), `wonremote-failure-${process.pid}-${failure}-${Date.now()}`);
      try {
        await mkdir(baseDir, { recursive: true });
        await writeFile(path.join(baseDir, "installer.exe"), "installer");
        const handoff = await prepareInstallerHandoff({
          installerPath: path.join(baseDir, "installer.exe"),
          installerArgs: ["/S"],
          installerSha256: createHash("sha256").update("installer").digest("hex"),
        }, { baseDir });
        const script = await readFile(handoff.scriptPath, "utf8");
        const start = script.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall");
        expect(start).toBeGreaterThan(0);
        const logger = ["locked-log", "locked-result"].includes(failure)
          ? script.slice(script.indexOf("function Write-HandoffLog"), script.indexOf("function Write-UpdateResult"))
          : "function Write-HandoffLog([string]$Message) {}";
        const resultWriter = script
          .slice(script.indexOf("function Write-UpdateResult"), script.indexOf("$UpdateLock = $null"))
          .replace("function Write-UpdateResult", "function SaveResult");
        const events = path.join(baseDir, "events.txt");
        const harness = path.join(baseDir, "failure.ps1");
        await writeFile(harness, `
$ErrorActionPreference = 'Stop'
$FailureExitCode = 1
$InstallerStarted = $false
$AcceptedPath = '${harness.replace(/'/g, "''")}.accepted'
$RestartMode = 'agent'
$RollbackRoot = '${baseDir.replace(/'/g, "''")}'
$LogPath = Join-Path $RollbackRoot 'handoff.log'
$ResultPath = Join-Path $RollbackRoot 'last-update-result.json'
$TargetVersion = '0.1.125'
function Record([string]$Event) { Add-Content -LiteralPath $env:WR_EVENTS -Value $Event }
function Backup-WonRemoteInstall { $script:RollbackEntries = @('backup'); Record 'backup' }
${logger}
${resultWriter}
function Start-Process {
  Record 'launch'
  if ($env:WR_FAILURE -eq 'launch') { throw 'installer launch rejected' }
  $p = [pscustomobject]@{ Id = 1; ExitCode = $(if ($env:WR_FAILURE -in @('installer','locked-log','locked-result','rollback')) { 5 } else { 0 }) }
  $p | Add-Member ScriptMethod WaitForExit {
    if ($env:WR_FAILURE -eq 'locked-log') {
      $script:LockedLog = [IO.File]::Open($LogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    }
    if ($env:WR_FAILURE -eq 'locked-result') {
      [IO.File]::WriteAllText($ResultPath, 'previous result')
      $script:LockedResult = [IO.File]::Open($ResultPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    }
  }
  return $p
}
function Start-WonRemoteAgent { Record 'start' }
function Wait-WonRemoteAgentRuntime { Record 'health'; if ($env:WR_FAILURE -eq 'runtime') { throw 'replacement runtime unavailable' } }
function Wait-WonRemoteAgentOnline { Record 'online'; throw 'replacement heartbeat unavailable' }
function Restore-WonRemoteInstall {
  Record 'restore-and-restart'
  if ($script:LockedResult) { $script:LockedResult.Dispose() }
  if ($env:WR_FAILURE -eq 'rollback') { throw 'original runtime unavailable' }
}
function Remove-WonRemoteRollback { Record 'cleanup-backup' }
function Write-UpdateResult([string]$State, [string]$Message) { Record $State; SaveResult $State $Message }
function Close-UpdateLock { if ($script:LockedLog) { $script:LockedLog.Dispose() }; Record 'unlock' }
${script.slice(start)}
`);
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
          env: { ...process.env, WR_EVENTS: events, WR_FAILURE: failure }, encoding: "utf8", timeout: POWERSHELL_HARNESS_TIMEOUT_MS, windowsHide: true,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(["installer", "locked-log", "locked-result", "rollback"].includes(failure) ? 5 : 1);
        const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/);
        const receipt = JSON.parse((await readFile(path.join(baseDir, "last-update-result.json"), "utf8")).replace(/^\uFEFF/, ""));
        if (failure === "launch") {
          expect(recorded).toEqual(["backup", "launch", "failed", "cleanup-backup", "unlock"]);
          await expect(stat(`${harness}.accepted`)).rejects.toThrow();
        } else if (failure === "rollback") {
          expect(recorded).toEqual(["backup", "launch", "rollback", "restore-and-restart", "failed", "unlock"]);
          expect(receipt.error).toContain("Install: Installer exited with code 5.; Rollback: original runtime unavailable");
          await expect(stat(path.join(baseDir, "ROLLBACK_FAILED"))).resolves.toBeDefined();
        } else {
          expect(recorded).toEqual([
            "backup", "launch", ...(["runtime", "online"].includes(failure) ? ["start", "health"] : []),
            ...(failure === "online" ? ["online"] : []),
            "rollback", "restore-and-restart", "rollback", "cleanup-backup", "unlock",
          ]);
          expect(receipt).toMatchObject({ state: "rollback", targetVersion: "0.1.125",
            error: expect.stringContaining("The new runtime failed and the previous version was restored.") });
          if (failure === "locked-result") {
            expect(await readFile(path.join(baseDir, "handoff.log"), "utf8")).toContain("Could not record in-progress rollback");
          }
        }
      } finally { await rm(baseDir, { recursive: true, force: true }); }
    },
    POWERSHELL_CASE_TIMEOUT_MS,
  );
  it.runIf(process.platform === "win32").each(["baseline-rejected", "rollback", "rollback-unconfirmed", "healthy"])(
    "qualifies the protected first-hop runtime at the %s boundary",
    async (scenario) => {
      const baseDir = path.join(os.tmpdir(), "wonremote-first-hop-" + process.pid + "-" + scenario + "-" + Date.now());
      try {
        const programFiles = path.join(baseDir, "Program Files");
        const root = path.join(programFiles, "WonRemote Agent");
        const stage = path.join(root, ".update-handoff", "fixture");
        const updates = path.join(baseDir, "WonRemote", "updates");
        const installer = path.join(updates, "installer.exe");
        const agent = path.join(root, "wonremote-viewer.exe");
        const events = path.join(baseDir, "events.txt");
        await mkdir(stage, { recursive: true });
        await mkdir(updates, { recursive: true });
        await writeFile(agent, "old Agent");
        await writeFile(installer, "fixture");
        await writeFile(path.join(baseDir, "WonRemote", "agent-config.json"),
          JSON.stringify({ registeredDeviceId: "local-agent", installId: "local-install" }));
        await writeFile(path.join(root, "agent-update-health.ps1"), `
function Wait-AgentSecureCaptureTask { Record 'capture-ready' }
function Wait-AgentOnlineReceipt($ReceiptPath,$Root,$Version,$Identity,[datetime]$Since) {
  if ($Identity.registeredDeviceId -cne 'local-agent' -or $Identity.installId -cne 'local-install') { throw 'Wrong registration' }
  if ($Since -eq [datetime]::MinValue) {
    Record ('baseline-' + $Version)
    try {
      $unexpected=[IO.File]::Open($LockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      $unexpected.Dispose()
      throw 'Verification ran without the handoff lock'
    } catch [IO.IOException] {}
    if ($env:WR_SCENARIO -eq 'baseline-rejected') { throw 'Original receipt unavailable' }
  } else {
    Record ('fresh-' + $Version)
    if (($env:WR_SCENARIO -ne 'healthy' -and $Since -lt $script:installerExited) -or
        $Since -gt $script:agentStarted) { throw 'Wrong restart freshness boundary' }
    if ($env:WR_SCENARIO -eq 'rollback-unconfirmed') { throw 'Original restart receipt did not verify' }
  }
}
`);
        const handoff = await prepareInstallerHandoff({
          installerPath: installer, installerArgs: ["/S"],
          installerSha256: createHash("sha256").update("fixture").digest("hex"),
        }, { baseDir, restartMode: "agent", restartExecutablePath: agent, targetVersion: "0.1.125", legacyFirstHop: true });
        const source = await readFile(handoff.scriptPath, "utf8");
        const start = source.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall");
        const harness = path.join(stage, "handoff.ps1");
        const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
        await writeFile(harness, source.slice(0, start) + `
$env:ProgramFiles=${quote(programFiles)}
function Record([string]$Event) { Add-Content -LiteralPath $env:WR_EVENTS -Value $Event }
function Assert-WonRemoteRollbackBoundary {}
function Assert-TrustedRollbackDirectory($Path,$ProtectedRoots) {
  if ($Path -cne (Join-Path $PSScriptRoot 'installer-temp') -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw 'First-hop installer temp root was not created and checked'
  }
}
function Stop-WonRemoteProcesses {}
function Wait-WonRemoteAgentRuntime { Record 'runtime-ready' }
function Test-WonRemoteAgentRunning { $false }
function Get-Item {
  param([string]$LiteralPath,[switch]$Force)
  if ($LiteralPath -ieq $RestartExecutablePath) {
    return [pscustomobject]@{ PSIsContainer=$false; Attributes=0; VersionInfo=[pscustomobject]@{ProductVersion='0.1.123'} }
  }
  Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters
}
function Get-ScheduledTask($TaskPath,$TaskName) {
  if ($TaskName -ceq 'WonRemote Agent') {
    $root = Get-BrokeredAgentInstallRoot
    return [pscustomobject]@{
      TaskName=$TaskName; State='Ready'
      Actions=@([pscustomobject]@{ Execute=(Join-Path $root 'wonremote-viewer.exe'); Arguments='--agent'; WorkingDirectory=$root })
      Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;LogonType='Interactive';RunLevel='Highest'}
      Settings=[pscustomobject]@{Enabled=$true;AllowDemandStart=$true}
    }
  }
  [pscustomobject]@{
    Actions=@([pscustomobject]@{ Execute=(Join-Path (Get-BrokeredAgentInstallRoot) 'bin\\wonremote-poc.exe'); Arguments='--mode secure-broker' })
    Principal=[pscustomobject]@{UserId='SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'}
    Settings=[pscustomobject]@{Enabled=$true;AllowDemandStart=$true;MultipleInstances='IgnoreNew'}
  }
}
function Start-ScheduledTask($InputObject) {
  if ($InputObject.TaskName -ceq 'WonRemote Agent') {
    $script:agentStarted=[datetime]::UtcNow
    Record 'agent-start'
  } else { Record 'capture-start' }
}
function Start-Process {
  param([string]$FilePath)
  if ($FilePath -ieq $RestartExecutablePath) {
    throw 'First hop bypassed the original Agent task'
  }
  if ($env:TEMP -cne (Join-Path $PSScriptRoot 'installer-temp') -or $env:TMP -cne $env:TEMP) {
    throw 'Privileged installer was not started with its protected temporary path'
  }
  Record 'installer'
  $process=[pscustomobject]@{Id=1;ExitCode=$(if ($env:WR_SCENARIO -eq 'healthy') { 0 } else { 5 })}
  $process | Add-Member ScriptMethod WaitForExit { $script:installerExited=[datetime]::UtcNow }
  $process
}
` + source.slice(start));
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", harness], {
          encoding: "utf8", windowsHide: true, timeout: POWERSHELL_HARNESS_TIMEOUT_MS,
          env: { ...process.env, WR_SCENARIO: scenario, WR_EVENTS: events },
        });
        expect(result.status, result.stderr + result.stdout).toBe(scenario === "healthy" ? 0 : scenario === "baseline-rejected" ? 1 : 5);
        const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/);
        const receipt = JSON.parse((await readFile(path.join(updates, "last-update-result.json"), "utf8")).replace(/^\uFEFF/, ""));
        if (scenario === "baseline-rejected") {
          expect(recorded).toEqual(["capture-ready", "baseline-0.1.123"]);
          expect(receipt.state).toBe("failed");
        } else {
          expect(recorded).toEqual(["capture-ready", "baseline-0.1.123", "installer",
            "capture-start", "agent-start", "runtime-ready", "capture-ready", scenario === "healthy" ? "fresh-0.1.125" : "fresh-0.1.123"]);
          expect(receipt.state).toBe(scenario === "rollback-unconfirmed" ? "failed" : scenario);
          if (scenario === "rollback-unconfirmed") expect(receipt.error).toContain("Original restart receipt did not verify");
        }
      } finally { await rm(baseDir, { recursive: true, force: true }); }
    },
    POWERSHELL_CASE_TIMEOUT_MS,
  );
  it.runIf(process.platform === "win32")("refuses unsafe backup before install and preserves the active protected handoff on restore", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-protected-rollback-${process.pid}-${Date.now()}`);
    try {
      const programFiles = path.join(baseDir, "Program Files");
      const root = path.join(programFiles, "WonRemote Agent");
      const stage = path.join(root, ".update-handoff", "test");
      const localAppData = path.join(baseDir, "local");
      const legacy = path.join(localAppData, "WonRemote", "Agent");
      await mkdir(stage, { recursive: true });
      await mkdir(legacy, { recursive: true });
      await writeFile(path.join(legacy, "legacy.txt"), "do not modify");
      await writeFile(path.join(root, "app.txt"), "previous-version");
      await writeFile(path.join(stage, "handoff-alive.txt"), "running");
      const installer = path.join(baseDir, "installer.exe");
      await writeFile(installer, "installer");
      const handoff = await prepareInstallerHandoff({ installerPath: installer, installerArgs: ["/S"],
        installerSha256: createHash("sha256").update("installer").digest("hex") }, { baseDir, targetVersion: "0.1.105" });
      const script = await readFile(handoff.scriptPath, "utf8");
      const prefix = script.slice(0, script.lastIndexOf("\ntry {\n  Backup-WonRemoteInstall"));
      const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const unprotected = path.join(baseDir, "unprotected-handoff.ps1");
      await writeFile(unprotected, prefix + `
$env:ProgramFiles=${q(programFiles)}
\${env:ProgramFiles(x86)}=${q(programFiles)}
function Get-WonRemoteInstallRoots { return ${q(root)} }
try {
  Backup-WonRemoteInstall
  throw 'Unsafe backup was accepted before installer launch.'
} catch {
  if ($_.Exception.Message -notlike '*user-writable*') { throw }
}
if (Test-Path -LiteralPath $RollbackRoot) { throw 'Unsafe backup directory was created.' }
Close-UpdateLock
`);
      const refused = spawnSync("powershell.exe", ["-NoProfile", "-File", unprotected], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      expect(refused.status, refused.stderr + refused.stdout).toBe(0);
      const harness = path.join(stage, "rollback-test.ps1");
      await writeFile(harness, prefix + `
$env:ProgramFiles=${q(programFiles)}
\${env:ProgramFiles(x86)}=${q(programFiles)}
$env:LOCALAPPDATA=${q(localAppData)}
function Get-Acl {
  param($LiteralPath)
  $result = [pscustomobject]@{}
  $result | Add-Member ScriptMethod GetOwner { return @{ Value = 'S-1-5-32-544' } }
  $result | Add-Member ScriptMethod GetAccessRules {
    if ($script:userWritable) { return @{ IdentityReference = @{ Value = 'S-1-5-32-545' }; AccessControlType = 'Allow'; FileSystemRights = 2 } }
  }
  return $result
}
function Stop-WonRemoteProcesses {}
function Start-WonRemoteAgent {}
function Wait-WonRemoteAgentRuntime {}
$script:userWritable = $true
try {
  Backup-WonRemoteInstall
  throw 'Unexpected writable stage accepted'
} catch {
  if ($_.Exception.Message -notlike '*user-writable*') { throw }
}
$script:userWritable = $false
Backup-WonRemoteInstall
if (-not (Test-UnderPath $RollbackRoot $PSScriptRoot)) { throw 'backup is unprotected' }
if ($script:RollbackEntries.Count -ne 1 -or $script:RollbackEntries[0].Root -ne ${q(root)}) { throw 'Legacy directory was treated as a restore target' }
if (Test-Path -LiteralPath (Join-Path $RollbackRoot '0\\.update-handoff')) { throw 'recursive stage backup' }
Set-Content -LiteralPath ${q(path.join(root, "app.txt"))} -Value 'broken'
Restore-WonRemoteInstall
if (-not (Test-Path -LiteralPath ${q(path.join(stage, "handoff-alive.txt"))})) { throw 'active updater deleted' }
Remove-WonRemoteRollback
Close-UpdateLock
`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-File", harness], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(await readFile(path.join(root, "app.txt"), "utf8")).toBe("previous-version");
      expect(await readFile(path.join(legacy, "legacy.txt"), "utf8")).toBe("do not modify");
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });
  it.runIf(process.platform === "win32")("only permits the explicitly requested pre-receipt rollback to use legacy runtime proof", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-legacy-health-${process.pid}-${Date.now()}`);
    try {
      await mkdir(baseDir, { recursive: true });
      const installer = path.join(baseDir, "installer.exe");
      await writeFile(installer, "installer");
      const handoff = await prepareInstallerHandoff({ installerPath: installer, installerArgs: ["/S"],
        installerSha256: createHash("sha256").update("installer").digest("hex") }, { baseDir });
      const script = await readFile(handoff.scriptPath, "utf8");
      const functionBody = script.slice(script.indexOf("function Wait-WonRemoteAgentOnline"), script.indexOf("function Start-WonRemoteAgent"));
      const harness = path.join(baseDir, "legacy-health.ps1");
      await writeFile(harness, `$ErrorActionPreference='Stop'
${functionBody}
function Write-HandoffLog([string]$Message) {}
function Get-WonRemoteAgentRoots { return @() }
$LegacyRollback=$true; $TargetVersion='0.1.104'; Wait-WonRemoteAgentOnline
foreach ($case in @(@{legacy=$false;version='0.1.104'},@{legacy=$true;version='0.1.105'})) {
  $LegacyRollback=$case.legacy; $TargetVersion=$case.version
  try { Wait-WonRemoteAgentOnline; throw 'missing verifier accepted' }
  catch { if ($_.Exception.Message -ne 'Installed Agent online verifier or target version is missing.') { throw } }
}`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-File", harness], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });
  it.runIf(process.platform === "win32")("executes successful handoff cleanup without deleting failure evidence or identity", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-cleanup-${process.pid}-${Date.now()}`);
    const updates = path.join(baseDir, "WonRemote", "updates");
    await mkdir(updates, { recursive: true });
    const installer = path.join(updates, "current.exe");
    try {
      await writeFile(installer, "temporary");
      const handoff = await prepareInstallerHandoff({
        installerPath: installer,
        installerArgs: ["/S"],
        installerSha256: createHash("sha256").update("temporary").digest("hex"),
      }, { baseDir });
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
      await writeFile(harness, "$InstallerPath=$env:WR_TEST_INSTALLER\n$OriginalInstallerPath=$InstallerPath\n$AcceptedPath=$env:WR_TEST_HANDOFF + '.accepted'\n$PSCommandPath=$env:WR_TEST_HANDOFF\n" + script.slice(start, end));
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

  it("rejects an installer changed after signed checksum verification", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-installer-tamper-${process.pid}-${Date.now()}`);
    const installerPath = path.join(baseDir, "WonRemote", "updates", "installer.exe");
    try {
      await mkdir(path.dirname(installerPath), { recursive: true });
      await writeFile(installerPath, "tampered");
      await expect(prepareInstallerHandoff({
        installerArgs: ["/S"],
        installerPath,
        installerSha256: createHash("sha256").update("signed").digest("hex"),
      }, { baseDir })).rejects.toThrow("Installer changed after checksum verification");
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

  it("prepares a hash-pinned PowerShell installer handoff", async () => {
    const baseDir = path.join(os.tmpdir(), `wonremote-installer-handoff-${process.pid}-${Date.now()}`);
    const installerPath = path.join(baseDir, "WonRemote", "updates", "WonRemote-Viewer-Agent-Setup.exe");

    try {
      await mkdir(path.dirname(installerPath), { recursive: true });
      await writeFile(installerPath, "installer");

      const result = await prepareInstallerHandoff(
        {
          installerArgs: ["/S", "/D=C:\\Users\\Tester\\WonRemote Agent"],
          installerPath,
          installerSha256: createHash("sha256").update("installer").digest("hex"),
        },
        { baseDir },
      );

      const script = await readFile(result.scriptPath, "utf8");
      expect(result.command).toBe("powershell.exe");
      expect(result.args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", result.scriptPath]);
      expect(result.creationFlags).toBe(INSTALLER_HANDOFF_CREATION_FLAGS);
      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.installerSha256).toBe(createHash("sha256").update("installer").digest("hex"));
      expect(result.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
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
      expect(script).toContain("WONREMOTE_HANDOFF_INSTALLER_PATH");
      expect(script).toContain("WONREMOTE_HANDOFF_ACCEPTED_PATH");
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
      const readinessSignal = script.indexOf("Set-Content -LiteralPath $AcceptedPath", installerLaunch);
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
      expect(script).toContain('Write-HandoffLog "Installer handoff failed: $installError"');
      expect(script).toContain("Restore-WonRemoteInstall");
      const second = await prepareInstallerHandoff(
        {
          installerArgs: ["/S"],
          installerPath,
          installerSha256: createHash("sha256").update("installer").digest("hex"),
        },
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
        {
          installerArgs: ["/S"],
          installerPath,
          installerSha256: createHash("sha256").update("installer").digest("hex"),
        },
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
        {
          installerArgs: ["/S"],
          installerPath,
          installerSha256: createHash("sha256").update("installer").digest("hex"),
        },
        { baseDir, restartMode: "agent", restartExecutablePath },
      );
      const script = await readFile(result.scriptPath, "utf8");
      expect(script).toContain(restartExecutablePath);
      expect(script).toContain("Start-Process -FilePath $RestartExecutablePath");
      expect(result.protectedAcknowledgementPath).toBe(path.join(
        path.dirname(restartExecutablePath),
        ".update-handoff",
        result.requestId,
        "installer-started.accepted",
      ));
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
