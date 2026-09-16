param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Agent", "Viewer")]
  [string] $Product,
  [string] $InstallRoot
)

$ErrorActionPreference = "Stop"

function Convert-ExtendedPath([string] $Value) {
  $normalized = [System.IO.Path]::GetFullPath($Value).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
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

if ($Product -eq "Agent") {
  Stop-ScheduledTask -TaskName "WonRemote Secure Capture" -ErrorAction SilentlyContinue
}

$roots = @()
if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
  $roots += Convert-ExtendedPath $InstallRoot
}
if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  $roots += Convert-ExtendedPath (Join-Path $env:LOCALAPPDATA "WonRemote\$Product")
}
$roots = @($roots | Select-Object -Unique)
if ($roots.Count -eq 0) { exit 0 }
$prefixes = @($roots | ForEach-Object { $_ + [System.IO.Path]::DirectorySeparatorChar })
# An update handoff writes readiness after the installer process starts. Give the
# Agent child time to observe it and exit with the dedicated handoff code.
Start-Sleep -Milliseconds 500
$self = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $PID) -ErrorAction SilentlyContinue
$installerPid = if ($null -ne $self) { [int] $self.ParentProcessId } else { -1 }
$processes = @(Get-CimInstance Win32_Process)
$targetIds = New-Object "System.Collections.Generic.HashSet[int]"

foreach ($process in $processes) {
  $id = [int] $process.ProcessId
  if (
    $id -eq 0 -or
    $id -eq $PID -or
    $id -eq $installerPid -or
    [string]::IsNullOrWhiteSpace($process.ExecutablePath)
  ) {
    continue
  }
  try {
    $candidate = Convert-ExtendedPath $process.ExecutablePath
  } catch {
    continue
  }
  $insideInstallRoot = $prefixes | Where-Object {
    $candidate.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase)
  }
  if ($insideInstallRoot) {
    [void] $targetIds.Add($id)
  }
}

do {
  $added = $false
  foreach ($process in $processes) {
    $id = [int] $process.ProcessId
    $parentId = [int] $process.ParentProcessId
    if (
      $id -eq 0 -or
      $id -eq $PID -or
      $id -eq $installerPid -or
      $targetIds.Contains($id)
    ) {
      continue
    }
    if ($targetIds.Contains($parentId)) {
      [void] $targetIds.Add($id)
      $added = $true
    }
  }
} while ($added)

foreach ($process in $processes) {
  $id = [int] $process.ProcessId
  if ($targetIds.Contains($id)) {
    Write-Output "Stopping WonRemote $Product PID $id`: $($process.ExecutablePath)"
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Milliseconds 1500
$remainingIds = @(
  Get-CimInstance Win32_Process |
    Where-Object { $targetIds.Contains([int] $_.ProcessId) } |
    ForEach-Object { [int] $_.ProcessId }
)
if ($remainingIds.Count -gt 0) {
  throw "WonRemote $Product process termination failed. Remaining PIDs: $($remainingIds -join ',')"
}

exit 0
