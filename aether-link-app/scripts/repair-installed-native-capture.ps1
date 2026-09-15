param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourcePath,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$taskNames = @("WonRemote Agent", "WonRemote Secure Capture")
$runtimeRoot = Join-Path ${env:ProgramFiles(x86)} "WonRemote Agent"
$targetPath = Join-Path $runtimeRoot "bin\wonremote-poc.exe"

function Resolve-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is not a file: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Wait-RuntimeStopped([string]$Path) {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $states = @($taskNames | ForEach-Object {
      (Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue).State
    })
    try {
      $handle = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $handle.Dispose()
      if ($states -notcontains "Running") { return }
    } catch [System.IO.IOException] {
      # The stopped SYSTEM broker may still hold the old image briefly.
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "WonRemote runtime did not release the installed native binary."
}

$source = Resolve-File $SourcePath "Source native binary"
$target = Resolve-File $targetPath "Installed native binary"
if ((Split-Path -Leaf $source) -ne "wonremote-poc.exe" -or (Split-Path -Leaf $target) -ne "wonremote-poc.exe") {
  throw "Only the expected WonRemote native binary can be repaired."
}
if (-not $target.StartsWith((Resolve-Path -LiteralPath $runtimeRoot).Path + "\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "Installed native binary is outside the protected WonRemote runtime."
}

$sourceHash = Get-Sha256 $source
$targetHash = Get-Sha256 $target
$result = [ordered]@{
  source = $source
  target = $target
  sourceSha256 = $sourceHash
  previousSha256 = $targetHash
  applied = $false
  restored = $false
  checkedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}

if ($sourceHash -eq $targetHash) {
  $result.applied = $true
  $result.reason = "already-current"
  $result | ConvertTo-Json | Write-Output
  exit 0
}

if ($WhatIf) {
  $result.reason = "would-stop-tasks-backup-replace-and-restart"
  $result | ConvertTo-Json | Write-Output
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Administrator approval is required to repair the protected WonRemote capture runtime."
}

$timestamp = (Get-Date).ToString("yyyyMMddHHmmss")
$backup = Join-Path (Split-Path -Parent $target) "wonremote-poc.before-duplex-repair-$timestamp.exe"
$staged = "$target.repair-$timestamp.tmp"

try {
  foreach ($taskName in $taskNames) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  Wait-RuntimeStopped $target
  Copy-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
  if ((Get-Sha256 $backup) -ne $targetHash) { throw "Installed native backup hash mismatch." }
  Copy-Item -LiteralPath $source -Destination $staged -ErrorAction Stop
  if ((Get-Sha256 $staged) -ne $sourceHash) { throw "Staged native binary hash mismatch." }
  Move-Item -LiteralPath $staged -Destination $target -Force
  if ((Get-Sha256 $target) -ne $sourceHash) { throw "Installed native binary hash mismatch after replacement." }
  Start-ScheduledTask -TaskName "WonRemote Secure Capture"
  Start-ScheduledTask -TaskName "WonRemote Agent"
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $broker = Get-ScheduledTask -TaskName "WonRemote Secure Capture" -ErrorAction SilentlyContinue
    $agent = Get-ScheduledTask -TaskName "WonRemote Agent" -ErrorAction SilentlyContinue
    if ($broker.State -eq "Running" -and $agent.State -eq "Running") { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if ($broker.State -ne "Running" -or $agent.State -ne "Running") { throw "WonRemote tasks did not return to Running." }
  $result.applied = $true
  $result.backup = $backup
  $result.installedSha256 = Get-Sha256 $target
} catch {
  Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
  if ((Test-Path -LiteralPath $backup -PathType Leaf) -and (Get-Sha256 $backup) -eq $targetHash) {
    Copy-Item -LiteralPath $backup -Destination $target -Force
    $result.restored = $true
  }
  foreach ($taskName in $taskNames) { Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
  throw
}

$result | ConvertTo-Json | Write-Output
