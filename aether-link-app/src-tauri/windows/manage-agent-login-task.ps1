param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Ensure", "Uninstall", "Migrate", "MonitorMigration", "RunMigrationBridge")]
  [string]$Mode,
  [string]$AgentPath,
  [string]$UserId,
  [string]$LegacyRoot,
  [string]$BridgePath,
  [string]$SourceNode,
  [switch]$UpdateHandoff,
  [datetime]$MigrationStartedUtc
)

$ErrorActionPreference = "Stop"
$taskName = "WonRemote Agent"
$secureTaskName = "WonRemote Secure Capture"
$migrationTaskName = "WonRemote Agent Migration"
$legacyUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WonRemote Agent"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $UserId) { $UserId = $identity.User.Value }

function Convert-ComparablePath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

function Test-PathUnder([string]$Candidate, [string]$Root) {
  $candidatePath = Convert-ComparablePath $Candidate
  $rootPath = Convert-ComparablePath $Root
  return $candidatePath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -or
    $candidatePath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-LegacyRoot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "The legacy Agent root is unavailable."
  }
  $resolved = Convert-ComparablePath $Path
  $expected = @(
    Convert-ComparablePath (Join-Path $env:LOCALAPPDATA "WonRemote\Agent")
    Convert-ComparablePath (Join-Path $env:LOCALAPPDATA "WonRemote Agent")
  )
  if (-not ($expected | Where-Object { $resolved.Equals($_, [StringComparison]::OrdinalIgnoreCase) })) {
    throw "Refusing to change an unexpected legacy Agent path: $resolved"
  }
  return $resolved
}

function Resolve-AgentRuntime([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $roots = @(
    [Environment]::GetFolderPath("ProgramFiles"),
    [Environment]::GetFolderPath("ProgramFilesX86")
  ) | Where-Object { $_ }
  $protected = $roots | Where-Object {
    $resolved.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
  }
  if (-not $protected) { return $null }
  $root = Split-Path -Parent $resolved
  $capture = Join-Path $root "bin\wonremote-poc.exe"
  $node = Join-Path $root "runtime\node.exe"
  $agentScript = Join-Path $root "agent\index.mjs"
  if (-not (Test-Path -LiteralPath $capture -PathType Leaf) -or
      -not (Test-Path -LiteralPath $node -PathType Leaf) -or
      -not (Test-Path -LiteralPath $agentScript -PathType Leaf)) {
    return $null
  }
  return @{
    Root = $root
    Agent = $resolved
    Capture = (Resolve-Path -LiteralPath $capture).Path
    Node = (Resolve-Path -LiteralPath $node).Path
    AgentScript = (Resolve-Path -LiteralPath $agentScript).Path
  }
}

function Resolve-ProtectedFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $roots = @(
    [Environment]::GetFolderPath("ProgramFiles"),
    [Environment]::GetFolderPath("ProgramFilesX86")
  ) | Where-Object { $_ }
  if (-not ($roots | Where-Object { Test-PathUnder $resolved $_ })) { return $null }
  return $resolved
}

function Test-AgentNodeRuntime($Runtime, [string]$Root) {
  return $null -ne (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    [System.IO.Path]::GetFileName($_.ExecutablePath) -ieq "node.exe" -and
    (Test-PathUnder $_.ExecutablePath $Root) -and
    [string]$_.CommandLine -match '(?i)[\\/]agent[\\/]index\.mjs' -and
    [string]$_.CommandLine -match '(?i)(^|\s)--watch(\s|$)'
  } | Select-Object -First 1)
}

function Wait-ProtectedAgentRuntime($Runtime) {
  $deadline = (Get-Date).AddSeconds(15)
  $stableChecks = 0
  do {
    if (Test-AgentNodeRuntime $Runtime $Runtime.Root) {
      $stableChecks++
      if ($stableChecks -ge 3) { return }
    } else {
      $stableChecks = 0
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "The protected WonRemote Agent runtime did not stay healthy."
}

function Wait-SecureBrokerTask {
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $task = Get-ScheduledTask -TaskName $secureTaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "The WonRemote secure-capture broker did not stay running."
}

function Get-UpdatePaths {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw "The WonRemote update directory is unavailable."
  }
  $root = Join-Path $env:APPDATA "WonRemote\updates"
  return @{
    Lock = Join-Path $root "update-handoff.lock"
    Result = Join-Path $root "last-update-result.json"
  }
}

function Test-UpdateLockHeld([string]$Path) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container) -or
      -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  try {
    $lock = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $lock.Dispose()
    return $false
  } catch [System.IO.IOException] {
    return $true
  }
}

function Stop-MigrationTasks([switch]$IncludeProtected) {
  Stop-ScheduledTask -TaskName $migrationTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $migrationTaskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($IncludeProtected) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $secureTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $secureTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

function Wait-UpdateLockRelease([string]$Path) {
  $deadline = (Get-Date).AddMinutes(5)
  do {
    if (-not (Test-UpdateLockHeld $Path)) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-FreshHealthyResult([string]$Path, [datetime]$StartedUtc) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $resultFile = Get-Item -LiteralPath $Path
    $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
    return $resultFile.LastWriteTimeUtc -ge $StartedUtc.ToUniversalTime() -and $result.state -eq "healthy"
  } catch {
    return $false
  }
}

function Remove-LegacyRuntime([string]$Path) {
  $legacy = Resolve-LegacyRoot $Path
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      if (Test-Path -LiteralPath $legacy) {
        Remove-Item -LiteralPath $legacy -Recurse -Force
      }
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "The obsolete legacy Agent runtime could not be removed."
}

function Remove-LegacyUninstallRegistration([string]$Path) {
  $legacy = Resolve-LegacyRoot $Path
  $entry = Get-ItemProperty -LiteralPath $legacyUninstallKey -ErrorAction SilentlyContinue
  if (-not $entry -or $entry.DisplayName -ne "WonRemote Agent" -or
      [string]::IsNullOrWhiteSpace([string]$entry.InstallLocation)) {
    return
  }
  try {
    $registeredRoot = Convert-ComparablePath (([string]$entry.InstallLocation).Trim().Trim('"'))
  } catch {
    return
  }
  if (-not $registeredRoot.Equals($legacy, [StringComparison]::OrdinalIgnoreCase)) {
    return
  }
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      Remove-Item -LiteralPath $legacyUninstallKey -Recurse -Force -ErrorAction Stop
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  Write-Warning "The obsolete WonRemote Agent uninstall entry could not be removed."
}

function Wait-MigrationTaskCompletion([datetime]$StartedUtc) {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $task = Get-ScheduledTask -TaskName $migrationTaskName -ErrorAction SilentlyContinue
    $info = Get-ScheduledTaskInfo -TaskName $migrationTaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne "Running" -and $info -and
        $info.LastRunTime.ToUniversalTime() -ge $StartedUtc.ToUniversalTime()) {
      if ([int64]$info.LastTaskResult -ne 0) {
        throw "The legacy WonRemote Agent cleanup task failed with result $($info.LastTaskResult)."
      }
      return
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "The legacy WonRemote Agent cleanup task did not complete."
}

function Invoke-RunMigrationBridge([string]$Path, [string]$NodePath, [string]$BridgeSource, [datetime]$StartedUtc, [bool]$WaitForHandoff) {
  $legacy = Resolve-LegacyRoot $Path
  if (-not $WaitForHandoff) {
    Remove-LegacyRuntime $legacy
    Remove-LegacyUninstallRegistration $legacy
    return
  }

  $protectedNode = Resolve-ProtectedFile $NodePath
  $protectedBridge = Resolve-ProtectedFile $BridgeSource
  if (-not $protectedNode -or -not $protectedBridge) {
    throw "The protected WonRemote Agent migration files are unavailable."
  }
  $updatePaths = Get-UpdatePaths
  if (-not (Test-UpdateLockHeld $updatePaths.Lock)) {
    throw "The deployed WonRemote updater no longer owns its migration lock."
  }

  Remove-LegacyRuntime $legacy
  $legacyNode = Join-Path $legacy "runtime\node.exe"
  $legacyScript = Join-Path $legacy "agent\index.mjs"
  New-Item -ItemType Directory -Path (Split-Path -Parent $legacyNode) -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $legacyScript) -Force | Out-Null
  Copy-Item -LiteralPath $protectedNode -Destination $legacyNode -Force
  Copy-Item -LiteralPath $protectedBridge -Destination $legacyScript -Force
  & $legacyNode $legacyScript --watch

  if (-not (Wait-UpdateLockRelease $updatePaths.Lock)) {
    throw "The deployed WonRemote updater did not release its migration lock."
  }
  if (-not (Test-FreshHealthyResult $updatePaths.Result $StartedUtc)) {
    throw "The protected replacement Agent did not publish fresh healthy update evidence."
  }
  Remove-LegacyRuntime $legacy
  Remove-LegacyUninstallRegistration $legacy
}

function Invoke-MigrationMonitor([string]$Path, [datetime]$StartedUtc) {
  Resolve-LegacyRoot $Path | Out-Null
  $updatePaths = Get-UpdatePaths
  $released = Wait-UpdateLockRelease $updatePaths.Lock
  $healthy = $released -and (Test-FreshHealthyResult $updatePaths.Result $StartedUtc)
  if (-not $healthy) {
    Stop-MigrationTasks -IncludeProtected
    throw "The protected replacement Agent migration did not complete successfully."
  }

  $deadline = (Get-Date).AddSeconds(15)
  do {
    $migrationTask = Get-ScheduledTask -TaskName $migrationTaskName -ErrorAction SilentlyContinue
    if (-not $migrationTask -or $migrationTask.State -ne "Running") { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if ($migrationTask -and $migrationTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $migrationTaskName -ErrorAction SilentlyContinue
  }
  Unregister-ScheduledTask -TaskName $migrationTaskName -Confirm:$false -ErrorAction SilentlyContinue
}

function Start-MigrationMonitor([string]$Path, [datetime]$StartedUtc) {
  $escapedScript = $PSCommandPath.Replace("'", "''")
  $escapedRoot = $Path.Replace("'", "''")
  $started = $StartedUtc.ToUniversalTime().ToString("o")
  $command = "& '$escapedScript' -Mode MonitorMigration -LegacyRoot '$escapedRoot' -MigrationStartedUtc ([datetime]'$started')"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $monitor = Start-Process "$PSHOME\powershell.exe" -ArgumentList @("-NoProfile", "-EncodedCommand", $encoded) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 250
  if ($monitor.HasExited) {
    throw "The WonRemote Agent migration monitor did not start."
  }
}

function Start-LegacyMigration($Runtime, [string]$Path, [string]$SourceBridge) {
  $legacy = Resolve-LegacyRoot $Path
  $protectedBridge = Resolve-ProtectedFile $SourceBridge
  if (-not $protectedBridge) {
    throw "The WonRemote Agent migration bridge is missing."
  }

  Start-ScheduledTask -TaskName $taskName
  Wait-ProtectedAgentRuntime $Runtime
  Wait-SecureBrokerTask

  $updatePaths = Get-UpdatePaths
  $waitForHandoff = Test-UpdateLockHeld $updatePaths.Lock
  $started = [datetime]::UtcNow
  $escapedScript = $PSCommandPath.Replace("'", "''")
  $escapedLegacy = $legacy.Replace("'", "''")
  $escapedNode = $Runtime.Node.Replace("'", "''")
  $escapedBridge = $protectedBridge.Replace("'", "''")
  $startedText = $started.ToString("o")
  $handoffArgument = if ($waitForHandoff) { " -UpdateHandoff" } else { "" }
  $command = "& '$escapedScript' -Mode RunMigrationBridge -LegacyRoot '$escapedLegacy' -SourceNode '$escapedNode' -BridgePath '$escapedBridge' -MigrationStartedUtc ([datetime]'$startedText')$handoffArgument"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  Stop-MigrationTasks
  $action = New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $Runtime.Root
  $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $migrationTaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $migrationTaskName

  if (-not $waitForHandoff) {
    Wait-MigrationTaskCompletion $started
    Stop-MigrationTasks
    return
  }

  $deadline = (Get-Date).AddSeconds(5)
  do {
    if (Test-AgentNodeRuntime $Runtime $legacy) {
      Start-MigrationMonitor $legacy $started
      return
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "The one-time WonRemote Agent updater bridge did not start."
}

$brokerArguments = "--mode secure-broker"

if ($Mode -eq "RunMigrationBridge") {
  if ($MigrationStartedUtc -eq [datetime]::MinValue) {
    throw "The Agent migration start time is required."
  }
  Invoke-RunMigrationBridge $LegacyRoot $SourceNode $BridgePath $MigrationStartedUtc $UpdateHandoff.IsPresent
  return
}

if ($Mode -eq "MonitorMigration") {
  if (-not $isAdmin) {
    throw "Administrator rights are required to monitor the protected Agent migration."
  }
  if ($MigrationStartedUtc -eq [datetime]::MinValue) {
    throw "The Agent migration start time is required."
  }
  Invoke-MigrationMonitor $LegacyRoot $MigrationStartedUtc
  return
}

$runtime = Resolve-AgentRuntime $AgentPath

if ($Mode -eq "Ensure") {
  $existingAgent = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $agentReady = $runtime -and $existingAgent -and $existingAgent.Principal.RunLevel -eq "Highest" -and
      $existingAgent.Actions.Execute -eq $runtime.Agent -and
      $existingAgent.Actions.Arguments -eq "--agent" -and
      $existingAgent.State -ne "Disabled"
  # The SYSTEM task may be unreadable to this caller. Its approved Agent task
  # performs broker validation after elevation; no new privilege is granted here.
  if ($agentReady -and -not $isAdmin) { exit 10 }
  $existingBroker = Get-ScheduledTask -TaskName $secureTaskName -ErrorAction SilentlyContinue
  if ($agentReady -and
      $existingBroker -and $existingBroker.Principal.UserId -eq "SYSTEM" -and
      $existingBroker.Actions.Execute -eq $runtime.Capture -and
      $existingBroker.Actions.Arguments -eq $brokerArguments -and
      $existingBroker.State -ne "Disabled") {
    if ($isAdmin) {
      if ($existingBroker.State -ne "Running") {
        Start-ScheduledTask -TaskName $secureTaskName
      }
      exit 0
    }
    exit 10
  }
}

if (-not $isAdmin -and $Mode -in @("Uninstall", "Migrate")) {
  throw "Administrator rights are required to change WonRemote machine tasks."
}

if (-not $isAdmin) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "WonRemote 에이전트 최초 실행 설정입니다.`r`n관리자 권한 자동 실행을 설정합니다. 다음 관리자 승인 창에서 '예'를 눌러주세요.",
    "WonRemote 에이전트 설정",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
  $elevatedMode = if ($Mode -eq "Ensure") { "Install" } else { $Mode }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode $elevatedMode -UserId `"$UserId`""
  if ($AgentPath) {
    $arguments += " -AgentPath `"$AgentPath`""
  }
  try {
    $process = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $arguments
    if ($Mode -eq "Ensure" -and $process.ExitCode -eq 0) { exit 10 }
    exit $process.ExitCode
  } catch {
    Write-Error "Administrator approval is required to configure WonRemote Agent startup."
    exit 1
  }
}

if ($Mode -eq "Uninstall") {
  Stop-ScheduledTask -TaskName $migrationTaskName -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName $secureTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $migrationTaskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $secureTaskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

if (-not $runtime) {
  throw "WonRemote Agent and secure capture runtime must be installed under Program Files."
}

try {
  $action = New-ScheduledTaskAction -Execute $runtime.Agent -Argument "--agent" -WorkingDirectory (Split-Path -Parent $runtime.Agent)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
  $brokerAction = New-ScheduledTaskAction -Execute $runtime.Capture -Argument $brokerArguments -WorkingDirectory (Split-Path -Parent $runtime.Capture)
  $brokerTrigger = New-ScheduledTaskTrigger -AtStartup
  $brokerPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $brokerSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $secureTaskName -Action $brokerAction -Trigger $brokerTrigger -Principal $brokerPrincipal -Settings $brokerSettings -Force | Out-Null
  Start-ScheduledTask -TaskName $secureTaskName

  $task = Get-ScheduledTask -TaskName $taskName
  $brokerTask = Get-ScheduledTask -TaskName $secureTaskName
  if ($task.Principal.RunLevel -ne "Highest" -or $task.Actions.Execute -ne $runtime.Agent -or $task.Actions.Arguments -ne "--agent" -or
      $brokerTask.Principal.UserId -ne "SYSTEM" -or $brokerTask.Actions.Execute -ne $runtime.Capture -or $brokerTask.Actions.Arguments -ne $brokerArguments) {
    throw "WonRemote Agent scheduled task verification failed."
  }

  if ($Mode -eq "Migrate") {
    Start-LegacyMigration $runtime $LegacyRoot $BridgePath
  }
} catch {
  if ($Mode -eq "Migrate") {
    Stop-MigrationTasks -IncludeProtected
  }
  throw
}
