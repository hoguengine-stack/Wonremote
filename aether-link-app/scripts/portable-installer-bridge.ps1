param(
  [Parameter(Mandatory = $true)] [string] $PortableRoot,
  [Parameter(Mandatory = $true)] [string] $CombinedArchivePath,
  [Parameter(Mandatory = $true)] [string] $AgentArchivePath,
  [Parameter(Mandatory = $true)] [string] $ExpectedVersion,
  [ValidateSet("agent", "viewer", "auto")] [string] $RestartMode = "auto"
)

$ErrorActionPreference = "Stop"

function Convert-ExtendedPath([string] $Value) {
  $normalized = [System.IO.Path]::GetFullPath($Value).TrimEnd("\")
  $extendedPrefix = -join @([char] 92, [char] 92, "?", [char] 92)
  $extendedUncPrefix = $extendedPrefix + "UNC" + [char] 92
  if ($normalized.StartsWith($extendedUncPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return (-join @([char] 92, [char] 92)) + $normalized.Substring($extendedUncPrefix.Length)
  }
  if ($normalized.StartsWith($extendedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $normalized.Substring($extendedPrefix.Length)
  }
  return $normalized
}

$PortableRoot = Convert-ExtendedPath $PortableRoot
$CombinedArchivePath = Convert-ExtendedPath $CombinedArchivePath
$AgentArchivePath = Convert-ExtendedPath $AgentArchivePath
$driveRoot = [System.IO.Path]::GetPathRoot($PortableRoot).TrimEnd("\")
if ($PortableRoot.Equals($driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Portable root cannot be a drive root."
}

$updateBase = $env:APPDATA
if ([string]::IsNullOrWhiteSpace($updateBase)) {
  $updateBase = $env:TEMP
}
if ([string]::IsNullOrWhiteSpace($updateBase)) {
  throw "APPDATA and TEMP are both unavailable."
}
$updateRoot = Join-Path $updateBase "WonRemote\updates\portable-installer-bridge"
$lockPath = Join-Path $updateBase "WonRemote\updates\update-handoff.lock"
$legacyHandoffPath = Join-Path $updateBase "WonRemote\updates\run-installer-update.ps1"
$stagingDir = Join-Path $updateRoot "staging"
$backupDir = Join-Path $updateRoot "backup"
$logPath = Join-Path $updateRoot "bridge.log"
$ownedEntries = @(
  "WonRemote Viewer.exe",
  "WonRemote Agent.exe",
  "README.txt",
  "wonremote-portable.json",
  "server",
  "agent",
  "runtime",
  "bin",
  "node_modules"
)
New-Item -ItemType Directory -Path $updateRoot -Force | Out-Null

$hasPortableAgent = Test-Path -LiteralPath (Join-Path $PortableRoot "WonRemote Agent.exe") -PathType Leaf
if (-not $hasPortableAgent) {
  exit 10
}
$hasPortableViewer = Test-Path -LiteralPath (Join-Path $PortableRoot "WonRemote Viewer.exe") -PathType Leaf
$ExpectedPackageKind = if ($hasPortableViewer) { "portable" } else { "portable-agent" }
$ArchivePath = if ($hasPortableViewer) { $CombinedArchivePath } else { $AgentArchivePath }
if ($RestartMode -eq "auto" -and (Test-Path -LiteralPath $legacyHandoffPath -PathType Leaf)) {
  $legacyHandoff = Get-Content -LiteralPath $legacyHandoffPath -Raw -Encoding UTF8
  if ($legacyHandoff -match '(?ms)if \(\$process\.ExitCode -eq 0\)\s*\{\s*Start-WonRemoteViewer\s*\}') {
    $RestartMode = "viewer"
  } elseif ($legacyHandoff -match '(?ms)if \(\$process\.ExitCode -eq 0\)\s*\{\s*Start-WonRemoteAgent\s*\}') {
    $RestartMode = "agent"
  }
}
if ($RestartMode -eq "auto") {
  $RestartMode = "agent"
}
$restartViewer = $ExpectedPackageKind -eq "portable" -and $RestartMode -eq "viewer"
$restartAgent = $true
$processesStopped = $false
$backupReady = $false

function Write-BridgeLog([string] $Message) {
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "[$(Get-Date -Format o)] $Message"
}

$updateLock = $null
try {
  $updateLock = [System.IO.File]::Open(
    $lockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch {
  Write-BridgeLog "Another portable update is already in progress."
  exit 20
}

function Close-UpdateLock {
  if ($null -ne $updateLock) {
    $updateLock.Dispose()
    $updateLock = $null
  }
}

function Normalize-PathForCompare([string] $Value) {
  return Convert-ExtendedPath $Value
}

function Test-UnderPortableRoot([string] $Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  $candidatePath = Normalize-PathForCompare $Candidate
  return $candidatePath.Equals($PortableRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $candidatePath.StartsWith("$PortableRoot\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Stop-PortableProcesses {
  $targets = Get-CimInstance Win32_Process | Where-Object { Test-UnderPortableRoot $_.ExecutablePath }
  foreach ($target in $targets) {
    if ($target.ProcessId -ne $PID) {
      Write-BridgeLog "Stopping portable process $($target.ProcessId): $($target.ExecutablePath)"
      Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 1500
}

function Remove-OwnedEntries([string] $Root) {
  foreach ($entry in $ownedEntries) {
    $target = Join-Path $Root $entry
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $target) {
      throw "Portable bridge could not remove owned entry: $target"
    }
  }
}

function Remove-TreeStrict([string] $Target) {
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $Target) {
    throw "Portable bridge could not remove stale work directory: $Target"
  }
}

function Copy-OwnedEntries([string] $SourceRoot, [string] $DestinationRoot) {
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($entry in $ownedEntries) {
    $source = Join-Path $SourceRoot $entry
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $DestinationRoot $entry) -Recurse -Force
    }
  }
}

function Start-PortableRuntimes {
  $started = @()
  if ($restartViewer) {
    $viewer = Join-Path $PortableRoot "WonRemote Viewer.exe"
    Write-BridgeLog "Starting migrated portable Viewer: $viewer"
    $started += Start-Process -FilePath $viewer -PassThru
  }
  if ($restartAgent) {
    $agent = Join-Path $PortableRoot "WonRemote Agent.exe"
    Write-BridgeLog "Starting migrated portable Agent: $agent --agent"
    $started += Start-Process -FilePath $agent -ArgumentList @("--agent") -PassThru
  }
  return $started
}

function Test-PortableAgentRuntime {
  $agentNode = Get-CimInstance Win32_Process | Where-Object {
    (Test-UnderPortableRoot $_.ExecutablePath) -and
    [System.IO.Path]::GetFileName($_.ExecutablePath) -ieq "node.exe" -and
    [string]$_.CommandLine -match '(?i)[\\/]agent[\\/]index\.mjs' -and
    [string]$_.CommandLine -match '(?i)(^|\s)--watch(\s|$)'
  } | Select-Object -First 1
  return $null -ne $agentNode
}

function Test-PortableRuntimes([object[]] $ExpectedProcesses, [bool] $ExpectAgent) {
  foreach ($expected in $ExpectedProcesses) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($expected.Id)" -ErrorAction SilentlyContinue
    if ($null -eq $process -or -not (Test-UnderPortableRoot $process.ExecutablePath)) {
      return $false
    }
  }
  if ($ExpectAgent -and -not (Test-PortableAgentRuntime)) {
    return $false
  }
  return $ExpectedProcesses.Count -gt 0
}

try {
  Set-Location $updateRoot
  Remove-TreeStrict $stagingDir
  Remove-TreeStrict $backupDir
  New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $stagingDir -Force

  $markerPath = Join-Path $stagingDir "wonremote-portable.json"
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.schemaVersion -ne 1 -or $marker.packageKind -ne $ExpectedPackageKind -or $marker.version -ne $ExpectedVersion) {
    throw "Portable bridge marker mismatch: kind=$($marker.packageKind), version=$($marker.version)."
  }
  foreach ($required in @("runtime", "agent", "bin", "WonRemote Agent.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $stagingDir $required))) {
      throw "Portable bridge archive is missing $required."
    }
  }
  if ($ExpectedPackageKind -eq "portable" -and -not (Test-Path -LiteralPath (Join-Path $stagingDir "WonRemote Viewer.exe"))) {
    throw "Portable bridge archive is missing WonRemote Viewer.exe."
  }

  Stop-PortableProcesses
  $processesStopped = $true
  Copy-OwnedEntries $PortableRoot $backupDir
  $backupReady = $true
  Remove-OwnedEntries $PortableRoot
  Copy-OwnedEntries $stagingDir $PortableRoot
  $startedProcesses = @(Start-PortableRuntimes)
  Start-Sleep -Seconds 12
  if (-not (Test-PortableRuntimes $startedProcesses $restartAgent)) {
    throw "Migrated portable runtime exited during verification."
  }

  Write-BridgeLog "Legacy portable migrated to $ExpectedVersion successfully."
  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  Close-UpdateLock
  exit 0
} catch {
  Write-BridgeLog "Legacy portable migration failed: $($_.Exception.Message)"
  if ($backupReady) {
    try {
      Stop-PortableProcesses
      Remove-OwnedEntries $PortableRoot
      Copy-OwnedEntries $backupDir $PortableRoot
      $null = Start-PortableRuntimes
      Write-BridgeLog "Legacy portable rollback completed."
    } catch {
      Write-BridgeLog "Legacy portable rollback restart failed: $($_.Exception.Message)"
    }
  } elseif ($processesStopped) {
    try { $null = Start-PortableRuntimes } catch {}
  }
  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Close-UpdateLock
  exit 1
}
