import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe.skipIf(process.platform !== "win32")("Agent first-run Windows boundaries", () => {
  it("compiles the actual Agent finish macro without optional action callbacks", () => {
    const root = path.join(process.env.LOCALAPPDATA!, "tauri", "NSIS");
    const output = path.join(mkdtempSync(path.join(os.tmpdir(), "wonremote-finish-test-")), "fixture.exe");
    execFileSync(path.join(root, "makensis.exe"), [
      `/DPLUGINPATH=${path.join(root, "Plugins", "x86-unicode", "additional")}`,
      `/DTESTOUTPUT=${output}`, path.resolve("scripts/test-agent-finish.nsi"),
    ], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    expect(readFileSync(output).subarray(0, 2).toString()).toBe("MZ");
    unlinkSync(output);
    rmdirSync(path.dirname(output));
  });

  it("compiles the actual install and legacy migration task paths in an installer section", () => {
    const root = path.join(process.env.LOCALAPPDATA!, "tauri", "NSIS");
    const output = path.join(mkdtempSync(path.join(os.tmpdir(), "wonremote-migration-nsis-")), "fixture.exe");
    execFileSync(path.join(root, "makensis.exe"), [
      `/DPLUGINPATH=${path.join(root, "Plugins", "x86-unicode", "additional")}`,
      `/DTESTOUTPUT=${output}`, path.resolve("scripts/test-agent-migration.nsi"),
    ], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    expect(readFileSync(output).subarray(0, 2).toString()).toBe("MZ");
    unlinkSync(output);
    rmdirSync(path.dirname(output));
  });

  it("uses an existing task without registration or UAC and distinguishes elevation", () => {
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    for (const admin of [true, false]) {
      // Run the real Ensure branch; every mutating command is replaced by a failing stub.
      const script = `
        function Test-Path { return $true }
        function Resolve-Path { param($LiteralPath); return [pscustomobject]@{Path=$LiteralPath} }
        function Get-ScheduledTask { param($TaskName); if ($TaskName -eq 'WonRemote Agent') { return [pscustomobject]@{ Principal=@{RunLevel='Highest'}; Actions=@{Execute='C:\\Program Files\\WonRemote Agent\\wonremote-viewer.exe';Arguments='--agent'};State='Ready' } }; return [pscustomobject]@{ Principal=@{UserId='SYSTEM'}; Actions=@{Execute='C:\\Program Files\\WonRemote Agent\\bin\\wonremote-poc.exe';Arguments='--mode secure-broker'};State='Running' } }
        function Register-ScheduledTask { throw 'Unexpected registration' }
        function Start-ScheduledTask { throw 'Unexpected launch' }
        function Start-Process { throw 'Unexpected elevation' }
        $source = [IO.File]::ReadAllText('${helper}')
        $source = $source.Replace('$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '$isAdmin = $${admin}')
        & ([scriptblock]::Create($source)) -Mode Ensure -AgentPath 'C:\\Program Files\\WonRemote Agent\\wonremote-viewer.exe'
      `;
      try {
        execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
        expect(admin).toBe(true);
      } catch (error) {
        expect(admin).toBe(false);
        expect((error as { status: number }).status).toBe(10);
      }
    }
  });

  it("restarts a stopped secure-capture task after an installer update", () => {
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    const script = [
      "$global:started = 0",
      "function Test-Path { return $true }",
      "function Resolve-Path { param($LiteralPath); return [pscustomobject]@{Path=$LiteralPath} }",
      "function Get-ScheduledTask {",
      "  param($TaskName)",
      "  if ($TaskName -eq 'WonRemote Agent') { return [pscustomobject]@{Principal=@{RunLevel='Highest'};Actions=@{Execute='C:\\Program Files\\WonRemote Agent\\wonremote-viewer.exe';Arguments='--agent'};State='Ready'} }",
      "  return [pscustomobject]@{Principal=@{UserId='SYSTEM'};Actions=@{Execute='C:\\Program Files\\WonRemote Agent\\bin\\wonremote-poc.exe';Arguments='--mode secure-broker'};State='Ready'}",
      "}",
      "function Register-ScheduledTask { throw 'Unexpected registration' }",
      "function Start-ScheduledTask { param($TaskName); if ($TaskName -ne 'WonRemote Secure Capture') { throw 'Unexpected task' }; Write-Output 'BROKER_RESTARTED' }",
      "function Start-Process { throw 'Unexpected elevation' }",
      "$source = [IO.File]::ReadAllText('" + helper + "')",
      "$source = $source.Replace('$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '$isAdmin = $true')",
      "& ([scriptblock]::Create($source)) -Mode Ensure -AgentPath 'C:\\Program Files\\WonRemote Agent\\wonremote-viewer.exe'",
    ].join("\n");
    expect(execFileSync(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15000, encoding: "utf8" },
    )).toContain("BROKER_RESTARTED");
  });

  it("creates the missing task on first execution without starting a competing Agent", () => {
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    const script = `
      $global:registered = @{}
      $global:started = 0
      function Get-ScheduledTask { param($TaskName); return $global:registered[$TaskName] }
      function Test-Path { return $true }
      function Resolve-Path { param($LiteralPath); return [pscustomobject]@{Path=$LiteralPath} }
      function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); return @{Execute=$Execute;Arguments=$Argument} }
      function New-ScheduledTaskTrigger { param([switch]$AtLogOn,[switch]$AtStartup,$User); return @{UserId=$User} }
      function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); return @{UserId=$UserId;RunLevel=$RunLevel} }
      function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances,$RestartCount,$RestartInterval); return @{} }
      function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force); $global:registered[$TaskName]=@{Principal=$Principal;Actions=$Action} }
      function Start-ScheduledTask { param($TaskName); if ($TaskName -ne 'WonRemote Secure Capture') { throw 'Unexpected Agent launch' }; $global:started++ }
      function Start-Process { throw 'Unexpected elevation' }
      $source = [IO.File]::ReadAllText('${helper}')
      $source = $source.Replace('$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '$isAdmin = $true')
      & ([scriptblock]::Create($source)) -Mode Ensure -AgentPath 'C:\\Program Files\\WonRemote Agent\\wonremote-viewer.exe'
      Write-Output "registered=$($global:registered.Count);started=$global:started"
    `;
    expect(execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000, encoding: "utf8" })).toContain("registered=2;started=1");
  });

  it("stops the SYSTEM broker and both protected and legacy Agent process trees before overwrite", () => {
    const helper = path.resolve("src-tauri/windows/stop-wonremote-processes.ps1").replace(/'/g, "''");
    const script = [
      "$env:LOCALAPPDATA = 'C:\\Users\\Test\\AppData\\Local'",
      "$global:events = [Collections.Generic.List[string]]::new()",
      "$global:stopped = [Collections.Generic.HashSet[int]]::new()",
      "$global:processes = @(",
      "  [pscustomobject]@{ProcessId=101;ParentProcessId=1;ExecutablePath='C:\\Program Files\\WonRemote Agent\\wonremote-viewer.exe'},",
      "  [pscustomobject]@{ProcessId=102;ParentProcessId=101;ExecutablePath=$null},",
      "  [pscustomobject]@{ProcessId=103;ParentProcessId=1;ExecutablePath='C:\\Users\\Test\\AppData\\Local\\WonRemote\\Agent\\wonremote-viewer.exe'},",
      "  [pscustomobject]@{ProcessId=104;ParentProcessId=1;ExecutablePath='C:\\Windows\\System32\\notepad.exe'}",
      ")",
      "function Stop-ScheduledTask { param($TaskName,$ErrorAction); Write-Output 'BROKER_STOPPED' }",
      "function Get-CimInstance {",
      "  param($ClassName,$Filter,$ErrorAction)",
      "  if ($Filter) { return [pscustomobject]@{ParentProcessId=9000} }",
      "  return @($global:processes | Where-Object { -not $global:stopped.Contains([int]$_.ProcessId) })",
      "}",
      "function Stop-Process {",
      "  param($Id,[switch]$Force,$ErrorAction)",
      "  [void]$global:stopped.Add([int]$Id)",
      "  Write-Output ('STOPPED_PID=' + $Id)",
      "}",
      "function Start-Sleep {}",
      "$source = [IO.File]::ReadAllText('" + helper + "')",
      "& ([scriptblock]::Create($source)) -Product Agent -InstallRoot 'C:\\Program Files\\WonRemote Agent'",
    ].join("\n");
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15000, encoding: "utf8" },
    );
    expect(output.indexOf("BROKER_STOPPED")).toBeLessThan(output.indexOf("STOPPED_PID=101"));
    expect(output).toContain("STOPPED_PID=102");
    expect(output).toContain("STOPPED_PID=103");
    expect(output).not.toContain("STOPPED_PID=104");
  });

  it("starts the real protected runtime before exposing the one-time legacy updater bridge", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wonremote-agent-migration-"));
    const appData = path.join(root, "Roaming");
    const localAppData = path.join(root, "Local");
    const updateRoot = path.join(appData, "WonRemote", "updates");
    const legacyRoot = path.join(localAppData, "WonRemote", "Agent");
    const protectedRoot = path.join(process.env.ProgramFiles!, "WonRemote Agent");
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    const bridge = path.join(protectedRoot, "legacy-agent-update-bridge.mjs").replace(/'/g, "''");
    mkdirSync(updateRoot, { recursive: true });
    mkdirSync(legacyRoot, { recursive: true });

    const script = `
      $env:APPDATA = '${appData.replace(/'/g, "''")}'
      $env:LOCALAPPDATA = '${localAppData.replace(/'/g, "''")}'
      $protectedRoot = '${protectedRoot.replace(/'/g, "''")}'
      $legacyRoot = '${legacyRoot.replace(/'/g, "''")}'
      $global:events = [Collections.Generic.List[string]]::new()
      $global:registered = @{}
      $global:protectedStarted = $false
      $global:bridgeStarted = $false
      function Test-Path { param($LiteralPath,$PathType); return $true }
      function Resolve-Path { param($LiteralPath); return [pscustomobject]@{Path=$LiteralPath} }
      function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
      function New-ScheduledTaskTrigger { param([switch]$AtLogOn,[switch]$AtStartup,$User); return @{} }
      function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); return [pscustomobject]@{UserId=$UserId;RunLevel=$RunLevel} }
      function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances,$RestartCount,$RestartInterval); return @{} }
      function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force); $global:registered[$TaskName]=[pscustomobject]@{Principal=$Principal;Actions=$Action;State='Ready'}; $global:events.Add("REGISTER:$($TaskName):$($Principal.RunLevel)") }
      function Get-ScheduledTask { param($TaskName,$ErrorAction); return $global:registered[$TaskName] }
      function Start-ScheduledTask { param($TaskName,$ErrorAction); $global:events.Add("START:$TaskName"); if ($TaskName -eq 'WonRemote Agent') { $global:protectedStarted=$true }; if ($TaskName -eq 'WonRemote Secure Capture') { $global:registered[$TaskName].State='Running' }; if ($TaskName -eq 'WonRemote Agent Migration') { $global:bridgeStarted=$true } }
      function Stop-ScheduledTask { param($TaskName,$ErrorAction); $global:events.Add("STOP:$TaskName") }
      function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm,$ErrorAction); $global:registered.Remove($TaskName); $global:events.Add("UNREGISTER:$TaskName") }
      function Get-CimInstance {
        param($ClassName,$ErrorAction)
        $items = @()
        if ($global:protectedStarted) { $items += [pscustomobject]@{ProcessId=201;Name='node.exe';ExecutablePath=(Join-Path $protectedRoot 'runtime\\node.exe');CommandLine=((Join-Path $protectedRoot 'agent\\index.mjs') + ' --watch')} }
        if ($global:bridgeStarted) { $items += [pscustomobject]@{ProcessId=202;Name='node.exe';ExecutablePath=(Join-Path $legacyRoot 'runtime\\node.exe');CommandLine=((Join-Path $legacyRoot 'agent\\index.mjs') + ' --watch')} }
        return $items
      }
      function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction); $global:events.Add("REMOVE:$LiteralPath") }
      function New-Item { param($ItemType,$Path,[switch]$Force); $global:events.Add("CREATE:$Path"); return [pscustomobject]@{} }
      function Copy-Item { param($LiteralPath,$Destination,[switch]$Force); $global:events.Add("COPY:$LiteralPath=>$Destination") }
      function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru); $global:events.Add('MONITOR'); return [pscustomobject]@{Id=203;HasExited=$false} }
      function Start-Sleep {}
      $lockPath = Join-Path $env:APPDATA 'WonRemote\\updates\\update-handoff.lock'
      $lock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      try {
        $source = [IO.File]::ReadAllText('${helper}')
        $source = $source.Replace('$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '$isAdmin = $true')
        & ([scriptblock]::Create($source)) -Mode Migrate -AgentPath (Join-Path $protectedRoot 'wonremote-viewer.exe') -LegacyRoot $legacyRoot -BridgePath '${bridge}' -UserId 'S-1-5-21-test'
      } finally { $lock.Dispose() }
      $global:events -join '|'
    `;
    try {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 15000, encoding: "utf8" },
      );
      expect(output).toContain("REGISTER:WonRemote Agent Migration:Limited");
      expect(output).toContain("START:WonRemote Agent Migration");
      expect(output).toContain("MONITOR");
      expect(output.indexOf("START:WonRemote Agent|")).toBeLessThan(output.indexOf("START:WonRemote Agent Migration"));
      expect(output).not.toContain(`REMOVE:${legacyRoot}`);
      expect(output).not.toContain("COPY:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy bridge alive only while the deployed updater owns its lock", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wonremote-agent-bridge-"));
    const updateRoot = path.join(root, "WonRemote", "updates");
    const lockPath = path.join(updateRoot, "update-handoff.lock");
    const readyPath = path.join(root, "lock-ready");
    mkdirSync(updateRoot, { recursive: true });
    const holderScript = `$f=[IO.File]::Open('${lockPath.replace(/'/g, "''")}',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [IO.File]::WriteAllText('${readyPath.replace(/'/g, "''")}','ready'); Start-Sleep -Milliseconds 800; $f.Dispose()`;
    const holder = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(holderScript, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
    const readyDeadline = Date.now() + 3000;
    while (!existsSync(readyPath) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(readyPath)).toBe(true);
    const bridge = spawn(process.execPath, [path.resolve("src-tauri/windows/legacy-agent-update-bridge.mjs"), "--watch"], {
      env: { ...process.env, APPDATA: root }, windowsHide: true, stdio: "ignore",
    });
    const waitForExit = (child: typeof holder) => child.exitCode !== null
      ? Promise.resolve(child.exitCode)
      : new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(bridge.exitCode).toBeNull();
      expect(await waitForExit(holder)).toBe(0);
      const bridgeCode = await Promise.race([
        waitForExit(bridge),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge did not exit after handoff lock release")), 3000)),
      ]);
      expect(bridgeCode).toBe(0);
    } finally {
      if (holder.exitCode === null) holder.kill();
      if (bridge.exitCode === null) bridge.kill();
      await Promise.all([waitForExit(holder), waitForExit(bridge)]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["healthy", "rollback"])("finalizes a %s legacy migration without accepting stale state", (state) => {
    const root = mkdtempSync(path.join(os.tmpdir(), `wonremote-agent-monitor-${state}-`));
    const appData = path.join(root, "Roaming");
    const localAppData = path.join(root, "Local");
    const updateRoot = path.join(appData, "WonRemote", "updates");
    const legacyRoot = path.join(localAppData, "WonRemote", "Agent");
    const resultPath = path.join(updateRoot, "last-update-result.json");
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    mkdirSync(updateRoot, { recursive: true });
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ state, updatedAt: new Date().toISOString() }));
    const script = `
      $env:APPDATA='${appData.replace(/'/g, "''")}'
      $env:LOCALAPPDATA='${localAppData.replace(/'/g, "''")}'
      $global:events=[Collections.Generic.List[string]]::new()
      function Get-ScheduledTask { param($TaskName,$ErrorAction); return [pscustomobject]@{State='Ready'} }
      function Stop-ScheduledTask { param($TaskName,$ErrorAction); $global:events.Add("STOP:$TaskName") }
      function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm,$ErrorAction); $global:events.Add("UNREGISTER:$TaskName") }
      function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction); $global:events.Add("REMOVE:$LiteralPath") }
      function Start-Sleep {}
      $source=[IO.File]::ReadAllText('${helper}')
      $source=$source.Replace('$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '$isAdmin = $true')
      & ([scriptblock]::Create($source)) -Mode MonitorMigration -LegacyRoot '${legacyRoot.replace(/'/g, "''")}' -MigrationStartedUtc ([datetime]'2000-01-01T00:00:00Z')
      $global:events -join '|'
    `;
    try {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 15000, encoding: "utf8" },
      );
      expect(output).toContain("UNREGISTER:WonRemote Agent Migration");
      if (state === "healthy") {
        expect(output).not.toContain("STOP:WonRemote Agent|");
      } else {
        expect(output).toContain("STOP:WonRemote Agent");
        expect(output).toContain("STOP:WonRemote Secure Capture");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans a legacy root through the limited migration task rather than the elevated installer", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wonremote-agent-limited-cleanup-"));
    const localAppData = path.join(root, "Local");
    const legacyRoot = path.join(localAppData, "WonRemote", "Agent");
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(path.join(legacyRoot, "stale.txt"), "legacy");
    const script = `
      $env:LOCALAPPDATA='${localAppData.replace(/'/g, "''")}'
      $source=[IO.File]::ReadAllText('${helper}')
      & ([scriptblock]::Create($source)) -Mode RunMigrationBridge -LegacyRoot '${legacyRoot.replace(/'/g, "''")}' -MigrationStartedUtc ([datetime]::UtcNow)
    `;
    try {
      execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 15000 },
      );
      expect(existsSync(legacyRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a cleanup task that finishes before its running state can be observed", () => {
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    const script = `
      $ErrorActionPreference='Stop'
      $source=[IO.File]::ReadAllText('${helper}')
      $functions=$source.Substring(0, $source.IndexOf('$brokerArguments = "--mode secure-broker"'))
      . ([scriptblock]::Create($functions)) -Mode Ensure
      function Get-ScheduledTask { param($TaskName,$ErrorAction); return [pscustomobject]@{State='Ready'} }
      function Get-ScheduledTaskInfo { param($TaskName,$ErrorAction); return [pscustomobject]@{LastRunTime=[datetime]::UtcNow;LastTaskResult=0} }
      function Start-Sleep { throw 'Unexpected wait' }
      Wait-MigrationTaskCompletion ([datetime]::UtcNow.AddSeconds(-1))
      Write-Output 'CLEANUP_COMPLETE'
    `;
    expect(execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15000, encoding: "utf8" },
    )).toContain("CLEANUP_COMPLETE");
  });

  it("removes only the stale current-user uninstall entry for the exact legacy root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wonremote-agent-uninstall-entry-"));
    const localAppData = path.join(root, "Local");
    const legacyRoot = path.join(localAppData, "WonRemote", "Agent");
    const helper = path.resolve("src-tauri/windows/manage-agent-login-task.ps1").replace(/'/g, "''");
    const script = `
      $ErrorActionPreference='Stop'
      $env:LOCALAPPDATA='${localAppData.replace(/'/g, "''")}'
      $source=[IO.File]::ReadAllText('${helper}')
      $functions=$source.Substring(0, $source.IndexOf('$brokerArguments = "--mode secure-broker"'))
      . ([scriptblock]::Create($functions)) -Mode Ensure
      $global:registeredRoot='"${legacyRoot.replace(/'/g, "''")}"'
      $global:removed=@()
      function Get-ItemProperty { return [pscustomobject]@{DisplayName='WonRemote Agent';InstallLocation=$global:registeredRoot} }
      function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction); $global:removed += $LiteralPath }
      function Start-Sleep { throw 'Unexpected retry' }
      Remove-LegacyUninstallRegistration '${legacyRoot.replace(/'/g, "''")}'
      $global:registeredRoot='"C:\\Users\\Other\\AppData\\Local\\WonRemote\\Agent"'
      Remove-LegacyUninstallRegistration '${legacyRoot.replace(/'/g, "''")}'
      $global:removed -join '|'
    `;
    try {
      const output = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 15000, encoding: "utf8" },
      );
      expect(output.trim()).toBe("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WonRemote Agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
