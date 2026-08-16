import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type InstallerUpdateMetadata = {
  assetName?: unknown;
  checksum?: unknown;
  downloadUrl?: unknown;
  installerArgs?: unknown;
  latestVersion?: unknown;
  updateKind?: unknown;
};

export type InstallerDownloadResult = {
  installerArgs: string[];
  installerPath: string;
};

export type InstallerHandoffResult = {
  args: string[];
  command: string;
  creationFlags: number;
  logPath: string;
  scriptPath: string;
};

export type SafeInstallerUpdateMetadata = InstallerUpdateMetadata & {
  checksum: string;
  downloadUrl: string;
  latestVersion: string;
  updateKind: "installer";
};

type DownloadInstallerOptions = {
  baseDir: string;
  fetchImpl?: typeof fetch;
};

type PrepareInstallerHandoffOptions = {
  baseDir: string;
  restartExecutablePath?: string;
  restartMode?: InstallerRestartMode;
};

export type InstallerRestartMode = "agent" | "viewer";

const CREATE_NO_WINDOW = 0x08000000;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
export const INSTALLER_HANDOFF_CREATION_FLAGS = CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB;

export function isInstallerUpdateMetadata(value: unknown): value is SafeInstallerUpdateMetadata {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.updateKind === "installer" &&
    typeof value.latestVersion === "string" &&
    value.latestVersion.trim().length > 0 &&
    typeof value.downloadUrl === "string" &&
    isHttpsUrl(value.downloadUrl) &&
    typeof value.checksum === "string" &&
    /^[a-fA-F0-9]{64}$/.test(value.checksum)
  );
}

export async function downloadInstallerUpdate(
  metadata: InstallerUpdateMetadata,
  options: DownloadInstallerOptions,
): Promise<InstallerDownloadResult> {
  if (!isInstallerUpdateMetadata(metadata)) {
    throw new Error("Installer update metadata is incomplete or unsafe.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(metadata.downloadUrl);
  if (!response.ok) {
    throw new Error(`Installer download failed: HTTP ${response.status}`);
  }

  const installerBuffer = Buffer.from(await response.arrayBuffer());
  const actualChecksum = createHash("sha256").update(installerBuffer).digest("hex");
  const expectedChecksum = metadata.checksum.toLowerCase();
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Installer checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  }

  const updatesDir = path.join(options.baseDir, "WonRemote", "updates");
  await mkdir(updatesDir, { recursive: true });
  const safeName = safeInstallerName(metadata);
  const installerPath = path.join(updatesDir, `${safeName.slice(0, -4)}-${randomUUID()}.exe`);
  await writeFile(installerPath, installerBuffer);

  return {
    installerArgs: installerArgsForUpdate(metadata),
    installerPath,
  };
}

export async function prepareInstallerHandoff(
  download: InstallerDownloadResult,
  options: PrepareInstallerHandoffOptions,
): Promise<InstallerHandoffResult> {
  const updatesDir = path.join(options.baseDir, "WonRemote", "updates");
  await mkdir(updatesDir, { recursive: true });

  const updateId = randomUUID();
  const logPath = path.join(updatesDir, `installer-handoff-${updateId}.log`);
  const scriptPath = path.join(updatesDir, `run-installer-update-${updateId}.ps1`);
  await writeFile(
    scriptPath,
    buildInstallerHandoffScript({
      installerArgs: download.installerArgs,
      installerPath: download.installerPath,
      lockPath: path.join(updatesDir, "update-handoff.lock"),
      logPath,
      restartExecutablePath: options.restartExecutablePath,
      restartMode: options.restartMode ?? "agent",
    }),
    "utf8",
  );

  return {
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    command: "powershell.exe",
    creationFlags: INSTALLER_HANDOFF_CREATION_FLAGS,
    logPath,
    scriptPath,
  };
}

export function installerArgsForUpdate(metadata: Pick<InstallerUpdateMetadata, "installerArgs">): string[] {
  if (!Array.isArray(metadata.installerArgs)) {
    return ["/S"];
  }
  const args = metadata.installerArgs.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return args.length > 0 ? args : ["/S"];
}

function buildInstallerHandoffScript(input: {
  installerArgs: string[];
  installerPath: string;
  lockPath: string;
  logPath: string;
  restartExecutablePath?: string;
  restartMode: InstallerRestartMode;
}): string {
  const quotedArgs = input.installerArgs.map((arg) => `'${escapePowerShellSingleQuoted(arg)}'`).join(", ");
  const quotedExplicitInstallRoots = installerInstallRootsForHandoff(input.installerArgs)
    .map((root) => `'${escapePowerShellSingleQuoted(root)}'`)
    .join(", ");
  const restartCommand = input.restartMode === "viewer" ? "Start-WonRemoteViewer" : "Start-WonRemoteAgent";

  return `$ErrorActionPreference = 'Stop'
$LogPath = '${escapePowerShellSingleQuoted(input.logPath)}'
$InstallerPath = '${escapePowerShellSingleQuoted(input.installerPath)}'
$InstallerArgs = @(${quotedArgs})
$LockPath = '${escapePowerShellSingleQuoted(input.lockPath)}'
$RestartMode = '${escapePowerShellSingleQuoted(input.restartMode)}'
$RestartExecutablePath = '${escapePowerShellSingleQuoted(input.restartExecutablePath ?? "")}'
$explicitInstallRoots = @(${quotedExplicitInstallRoots})
$RollbackRoot = Join-Path (Split-Path -Parent $InstallerPath) ('rollback-' + [guid]::NewGuid().ToString())
$script:RollbackEntries = @()
$FailureExitCode = 1
function Write-HandoffLog([string]$Message) {
  $stamp = Get-Date -Format o
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$stamp] $Message"
}

$UpdateLock = $null
try {
  $UpdateLock = [System.IO.File]::Open(
    $LockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch {
  Write-HandoffLog 'Another WonRemote update is already in progress.'
  Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
  exit 20
}

function Close-UpdateLock {
  if ($null -ne $UpdateLock) {
    $UpdateLock.Dispose()
    $UpdateLock = $null
  }
}

function Convert-ExtendedPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  try {
    $normalized = [System.IO.Path]::GetFullPath($Value).TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
    $extendedPrefix = -join @([char]92, [char]92, '?', [char]92)
    $extendedUncPrefix = $extendedPrefix + 'UNC' + [char]92
    if ($normalized.StartsWith($extendedUncPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return (-join @([char]92, [char]92)) + $normalized.Substring($extendedUncPrefix.Length)
    }
    if ($normalized.StartsWith($extendedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $normalized.Substring($extendedPrefix.Length)
    }
    return $normalized
  } catch {
    return $Value.TrimEnd("\\", "/")
  }
}

function Normalize-PathForCompare([string]$Value) {
  return Convert-ExtendedPath $Value
}

function Test-UnderPath([string]$Candidate, [string[]]$Roots) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  $candidatePath = Normalize-PathForCompare $Candidate
  foreach ($root in $Roots) {
    $rootPath = Normalize-PathForCompare $root
    if ([string]::IsNullOrWhiteSpace($rootPath)) { continue }
    if ($candidatePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
    $rootPrefix = "$rootPath$([System.IO.Path]::DirectorySeparatorChar)"
    if ($candidatePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Stop-WonRemoteProcesses {
  $roots = @(Get-WonRemoteInstallRoots)
  $targets = Get-CimInstance Win32_Process | Where-Object {
    Test-UnderPath $_.ExecutablePath $roots
  }
  foreach ($target in $targets) {
    if ($target.ProcessId -ne $PID) {
      Write-HandoffLog "Stopping WonRemote process $($target.ProcessId): $($target.ExecutablePath)"
      Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 1500
}

function Get-WonRemoteInstallRoots {
  $roots = if ($RestartMode -eq 'agent') {
    @("$env:LOCALAPPDATA\\WonRemote\\Agent", "$env:LOCALAPPDATA\\WonRemote Agent")
  } else {
    @("$env:LOCALAPPDATA\\WonRemote\\Viewer", "$env:LOCALAPPDATA\\WonRemote Viewer")
  }
  if (-not [string]::IsNullOrWhiteSpace($RestartExecutablePath)) {
    $roots += Split-Path -Parent $RestartExecutablePath
  }
  return @($roots + $explicitInstallRoots) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { Normalize-PathForCompare $_ } |
    Select-Object -Unique
}

function Backup-WonRemoteInstall {
  New-Item -ItemType Directory -Path $RollbackRoot -Force | Out-Null
  $pendingEntries = @()
  $index = 0
  try {
    foreach ($root in @(Get-WonRemoteInstallRoots)) {
      if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
      $backupPath = Join-Path $RollbackRoot ([string]$index)
      New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
      Get-ChildItem -LiteralPath $root -Force | Copy-Item -Destination $backupPath -Recurse -Force
      $pendingEntries += [pscustomobject]@{ Root = $root; Backup = $backupPath }
      Write-HandoffLog "Backed up WonRemote install root: $root"
      $index++
    }
    if ($pendingEntries.Count -eq 0) {
      throw 'No previous WonRemote installation was available to back up.'
    }
    $script:RollbackEntries = $pendingEntries
  } catch {
    Remove-WonRemoteRollback
    throw
  }
}

function Remove-WonRemoteRollback {
  if (Test-Path -LiteralPath $RollbackRoot) {
    Remove-Item -LiteralPath $RollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Restore-WonRemoteInstall {
  if ($script:RollbackEntries.Count -eq 0) {
    throw 'No previous WonRemote installation was available to restore.'
  }
  Stop-WonRemoteProcesses
  foreach ($entry in $script:RollbackEntries) {
    if (Test-Path -LiteralPath $entry.Root) {
      Remove-Item -LiteralPath $entry.Root -Recurse -Force
    }
    New-Item -ItemType Directory -Path $entry.Root -Force | Out-Null
    Get-ChildItem -LiteralPath $entry.Backup -Force | Copy-Item -Destination $entry.Root -Recurse -Force
    Write-HandoffLog "Restored WonRemote install root: $($entry.Root)"
  }
  ${restartCommand}
  if ($RestartMode -eq 'agent') {
    Wait-WonRemoteAgentRuntime
  } else {
    Wait-WonRemoteViewer
  }
  Write-HandoffLog 'WonRemote installer rollback completed and previous runtime recovered.'
}

function Test-WonRemoteAgentRunning([string[]]$Roots) {
  $target = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -ieq "wonremote-viewer.exe" -or $_.Name -ieq "WonRemote Agent.exe") -and
    (Test-UnderPath $_.ExecutablePath $Roots)
  } | Select-Object -First 1
  return $null -ne $target
}

function Get-WonRemoteAgentRoots {
  return @(
    $(if (-not [string]::IsNullOrWhiteSpace($RestartExecutablePath)) { Split-Path -Parent $RestartExecutablePath }),
    $explicitInstallRoots,
    "$env:LOCALAPPDATA\\WonRemote\\Agent",
    "$env:LOCALAPPDATA\\WonRemote Agent"
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
}

function Test-WonRemoteAgentRuntime([string[]]$Roots) {
  $target = Get-CimInstance Win32_Process | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    [System.IO.Path]::GetFileName($_.ExecutablePath) -ieq 'node.exe' -and
    (Test-UnderPath $_.ExecutablePath $Roots) -and
    [string]$_.CommandLine -match '(?i)[\\\\/]agent[\\\\/]index\\.mjs' -and
    [string]$_.CommandLine -match '(?i)(^|\\s)--watch(\\s|$)'
  } | Select-Object -First 1
  return $null -ne $target
}

function Wait-WonRemoteAgentRuntime {
  $roots = @(Get-WonRemoteAgentRoots)
  $deadline = (Get-Date).AddSeconds(15)
  do {
    if (Test-WonRemoteAgentRuntime $roots) {
      Write-HandoffLog 'WonRemote Agent node runtime health check passed.'
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'WonRemote Agent shell started, but its node.exe agent/index.mjs --watch runtime did not stay alive.'
}

function Start-WonRemoteAgent {
  $roots = @(Get-WonRemoteAgentRoots)
  if (Test-WonRemoteAgentRunning $roots) {
    Write-HandoffLog "WonRemote Agent is already running after installer exit; skipping fallback start."
    return
  }
  if (-not [string]::IsNullOrWhiteSpace($RestartExecutablePath) -and (Test-Path -LiteralPath $RestartExecutablePath)) {
    Write-HandoffLog "Starting WonRemote Agent from exact update origin: $RestartExecutablePath --agent"
    Start-Process -FilePath $RestartExecutablePath -ArgumentList @('--agent') -WindowStyle Hidden
    return
  }
  $candidates = @()
  foreach ($root in $roots) {
    $candidates += Join-Path $root "wonremote-viewer.exe"
    $candidates += Join-Path $root "WonRemote Agent.exe"
    $candidates += Join-Path $root "WonRemote Viewer.exe"
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      Write-HandoffLog "Starting WonRemote Agent: $candidate --agent"
      Start-Process -FilePath $candidate -ArgumentList @('--agent') -WindowStyle Hidden
      return
    }
  }
  Write-HandoffLog "No installed WonRemote Agent executable was found after installer exit."
}

function Start-WonRemoteViewer {
  $roots = @(
    $(if (-not [string]::IsNullOrWhiteSpace($RestartExecutablePath)) { Split-Path -Parent $RestartExecutablePath }),
    "$env:LOCALAPPDATA\\WonRemote\\Viewer",
    "$env:LOCALAPPDATA\\WonRemote Viewer",
    $explicitInstallRoots
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  if (Test-WonRemoteAgentRunning $roots) {
    Write-HandoffLog "WonRemote Viewer is already running after installer exit; skipping fallback start."
    return
  }
  if (-not [string]::IsNullOrWhiteSpace($RestartExecutablePath) -and (Test-Path -LiteralPath $RestartExecutablePath)) {
    Write-HandoffLog "Starting WonRemote Viewer from exact update origin: $RestartExecutablePath"
    Start-Process -FilePath $RestartExecutablePath
    return
  }
  $candidates = @()
  foreach ($root in $roots) {
    $candidates += Join-Path $root "wonremote-viewer.exe"
    $candidates += Join-Path $root "WonRemote Viewer.exe"
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      Write-HandoffLog "Starting WonRemote Viewer: $candidate"
      Start-Process -FilePath $candidate
      return
    }
  }
  Write-HandoffLog "No installed WonRemote Viewer executable was found after installer exit."
}

function Wait-WonRemoteViewer {
  $roots = @(
    $(if (-not [string]::IsNullOrWhiteSpace($RestartExecutablePath)) { Split-Path -Parent $RestartExecutablePath }),
    "$env:LOCALAPPDATA\\WonRemote\\Viewer",
    "$env:LOCALAPPDATA\\WonRemote Viewer",
    $explicitInstallRoots
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  $deadline = (Get-Date).AddSeconds(15)
  do {
    if (Test-WonRemoteAgentRunning $roots) {
      Write-HandoffLog 'WonRemote Viewer process health check passed.'
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'WonRemote Viewer did not stay alive after installer exit.'
}

try {
  Backup-WonRemoteInstall
  Stop-WonRemoteProcesses
  Write-HandoffLog "Starting installer update: $InstallerPath $($InstallerArgs -join ' ')"
  $process = Start-Process -FilePath $InstallerPath -ArgumentList $InstallerArgs -WindowStyle Hidden -PassThru
  Write-HandoffLog "Installer PID: $($process.Id)"
  $process.WaitForExit()
  Write-HandoffLog "Installer exit code: $($process.ExitCode)"
  if ($process.ExitCode -ne 0) {
    $FailureExitCode = $process.ExitCode
    throw "Installer exited with code $($process.ExitCode)."
  }
  ${restartCommand}
  if ($RestartMode -eq 'agent') {
    Wait-WonRemoteAgentRuntime
  } else {
    Wait-WonRemoteViewer
  }
  Remove-WonRemoteRollback
  Close-UpdateLock
  exit 0
} catch {
  Write-HandoffLog "Installer handoff failed: $($_.Exception.Message)"
  $rollbackCompleted = $false
  if ($script:RollbackEntries.Count -gt 0) {
    try {
      Restore-WonRemoteInstall
      $rollbackCompleted = $true
    } catch {
      Write-HandoffLog "Installer rollback failed: $($_.Exception.Message)"
      Write-HandoffLog "Rollback backup retained for manual recovery: $RollbackRoot"
    }
  } else {
    Write-HandoffLog 'Installer was not started because no complete rollback backup was available.'
  }
  if ($rollbackCompleted) {
    Remove-WonRemoteRollback
  }
  Close-UpdateLock
  exit $FailureExitCode
}
`;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function installerInstallRootsForHandoff(args: string[]): string[] {
  const roots = args
    .map((arg) => arg.trim())
    .filter((arg) => /^\/D=/i.test(arg))
    .map((arg) => arg.slice(3).trim())
    .filter(Boolean);
  return [...new Set(roots)];
}

function safeInstallerName(metadata: InstallerUpdateMetadata): string {
  const rawName = typeof metadata.assetName === "string" && metadata.assetName.trim()
    ? metadata.assetName.trim()
    : filenameFromUrl(String(metadata.downloadUrl ?? ""));
  const basename = path.basename(rawName).replace(/[<>:"|?*]/g, "_");
  return basename.toLowerCase().endsWith(".exe") ? basename : `${basename}.exe`;
}

function filenameFromUrl(downloadUrl: string): string {
  try {
    const url = new URL(downloadUrl);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "WonRemote Installer.exe");
  } catch {
    return "WonRemote Installer.exe";
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
