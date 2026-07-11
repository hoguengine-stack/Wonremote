param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Agent", "Viewer")]
  [string] $Product,

  [Parameter(Mandatory = $true)]
  [ValidateSet("x64", "x86")]
  [string] $Architecture
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  exit 0
}

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

function Test-TargetArchitecture([string] $Path, [int] $ExpectedMachine) {
  $stream = $null
  $reader = $null
  try {
    $sharing = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      $sharing
    )
    $reader = New-Object System.IO.BinaryReader($stream)
    $stream.Position = 60
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset + 4
    return $reader.ReadUInt16() -eq $ExpectedMachine
  } catch {
    return $false
  } finally {
    if ($null -ne $reader) {
      $reader.Dispose()
    } elseif ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

$root = Convert-ExtendedPath (Join-Path $env:LOCALAPPDATA "WonRemote\$Product")
$prefix = $root + [System.IO.Path]::DirectorySeparatorChar
$expectedMachine = if ($Architecture -eq "x64") { 0x8664 } else { 0x014c }
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
  if (
    $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
    (Test-TargetArchitecture $candidate $expectedMachine)
  ) {
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
