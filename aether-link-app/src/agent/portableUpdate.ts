import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProductionUpdateMetadata, ProductionUpdateKind } from "../domain/updateManifest";
import {
  INSTALLER_HANDOFF_CREATION_FLAGS,
  type InstallerRestartMode,
} from "./productionInstallerUpdate";

export const PORTABLE_MARKER_FILENAME = "wonremote-portable.json";
export const PORTABLE_OWNED_ENTRIES = [
  "WonRemote Viewer.exe",
  "WonRemote Agent.exe",
  "README.txt",
  PORTABLE_MARKER_FILENAME,
  "server",
  "agent",
  "runtime",
  "bin",
  "node_modules",
] as const;

export type PortablePackageKind = Extract<ProductionUpdateKind, "portable" | "portable-agent">;

export interface PortablePackageMarker {
  packageKind: PortablePackageKind;
  schemaVersion: 1;
  version: string;
}

export type SafePortableUpdateMetadata = ProductionUpdateMetadata & {
  updateKind: PortablePackageKind;
};

export interface PortableDownloadResult {
  archivePath: string;
  latestVersion: string;
  packageKind: PortablePackageKind;
}

export interface PortableHandoffResult {
  args: string[];
  command: string;
  creationFlags: number;
  logPath: string;
  scriptPath: string;
}

interface DownloadPortableOptions {
  baseDir: string;
  fetchImpl?: typeof fetch;
}

interface PreparePortableHandoffOptions {
  baseDir: string;
  portableRoot: string;
  restartMode: InstallerRestartMode;
}

export function isPortableUpdateMetadata(value: unknown): value is SafePortableUpdateMetadata {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.updateKind === "portable" || value.updateKind === "portable-agent") &&
    typeof value.latestVersion === "string" &&
    Boolean(value.latestVersion.trim()) &&
    typeof value.downloadUrl === "string" &&
    isHttpsUrl(value.downloadUrl) &&
    typeof value.checksum === "string" &&
    /^[a-f0-9]{64}$/i.test(value.checksum)
  );
}

export async function readPortablePackageMarker(portableRoot: string): Promise<PortablePackageMarker | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(path.resolve(portableRoot), PORTABLE_MARKER_FILENAME), "utf8"),
    ) as Partial<PortablePackageMarker>;
    if (
      parsed.schemaVersion === 1 &&
      (parsed.packageKind === "portable" || parsed.packageKind === "portable-agent") &&
      typeof parsed.version === "string" &&
      parsed.version.trim()
    ) {
      return {
        packageKind: parsed.packageKind,
        schemaVersion: 1,
        version: parsed.version.trim(),
      };
    }
  } catch {
    // Installed builds intentionally do not carry a portable marker.
  }
  return null;
}

export async function downloadPortableUpdate(
  metadata: SafePortableUpdateMetadata,
  options: DownloadPortableOptions,
): Promise<PortableDownloadResult> {
  if (!isPortableUpdateMetadata(metadata)) {
    throw new Error("Portable update metadata is incomplete or unsafe.");
  }
  const response = await (options.fetchImpl ?? fetch)(metadata.downloadUrl);
  if (!response.ok) {
    throw new Error(`Portable update download failed: HTTP ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actualChecksum = createHash("sha256").update(archive).digest("hex");
  if (actualChecksum !== metadata.checksum.toLowerCase()) {
    throw new Error(
      `Portable update checksum mismatch: expected ${metadata.checksum.toLowerCase()}, got ${actualChecksum}`,
    );
  }

  const updateDir = path.join(path.resolve(options.baseDir), "WonRemote", "updates");
  await mkdir(updateDir, { recursive: true });
  const safeName = safePortableArchiveName(metadata.assetName);
  const archivePath = path.join(updateDir, `${safeName.slice(0, -4)}-${randomUUID()}.zip`);
  await writeFile(archivePath, archive);
  return {
    archivePath,
    latestVersion: metadata.latestVersion,
    packageKind: metadata.updateKind,
  };
}

export async function preparePortableHandoff(
  download: PortableDownloadResult,
  options: PreparePortableHandoffOptions,
): Promise<PortableHandoffResult> {
  const portableRoot = validatePortableRoot(options.portableRoot);
  const currentPackageKind = await detectPortablePackageKind(portableRoot);
  if (currentPackageKind !== download.packageKind) {
    throw new Error("Portable update target marker is missing or does not match the release product.");
  }

  const updateDir = path.join(path.resolve(options.baseDir), "WonRemote", "updates");
  await mkdir(updateDir, { recursive: true });
  const updateId = randomUUID();
  const logPath = path.join(updateDir, `portable-update-handoff-${updateId}.log`);
  const scriptPath = path.join(updateDir, `run-portable-update-${updateId}.ps1`);
  await writeFile(
    scriptPath,
    buildPortableHandoffScript({
      archivePath: download.archivePath,
      expectedVersion: download.latestVersion,
      packageKind: download.packageKind,
      logPath,
      lockPath: path.join(updateDir, "update-handoff.lock"),
      portableRoot,
      restartMode: options.restartMode,
      backupDir: path.join(updateDir, `portable-backup-${updateId}`),
      stagingDir: path.join(updateDir, `portable-staging-${updateId}`),
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

async function detectPortablePackageKind(portableRoot: string): Promise<PortablePackageKind | null> {
  const marker = await readPortablePackageMarker(portableRoot);
  if (marker) {
    return marker.packageKind;
  }

  const hasAgent = await pathExists(path.join(portableRoot, "WonRemote Agent.exe"));
  if (!hasAgent) {
    return null;
  }
  return await pathExists(path.join(portableRoot, "WonRemote Viewer.exe"))
    ? "portable"
    : "portable-agent";
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

function buildPortableHandoffScript(input: {
  archivePath: string;
  expectedVersion: string;
  packageKind: PortablePackageKind;
  logPath: string;
  lockPath: string;
  portableRoot: string;
  restartMode: InstallerRestartMode;
  backupDir: string;
  stagingDir: string;
}): string {
  const ownedEntries = PORTABLE_OWNED_ENTRIES.map((entry) => `'${escapePowerShell(entry)}'`).join(", ");
  return `$ErrorActionPreference = 'Stop'
$PortableRoot = '${escapePowerShell(input.portableRoot)}'
$ArchivePath = '${escapePowerShell(input.archivePath)}'
$ExpectedVersion = '${escapePowerShell(input.expectedVersion)}'
$ExpectedPackageKind = '${escapePowerShell(input.packageKind)}'
$LogPath = '${escapePowerShell(input.logPath)}'
$LockPath = '${escapePowerShell(input.lockPath)}'
$StagingDir = '${escapePowerShell(input.stagingDir)}'
$BackupDir = '${escapePowerShell(input.backupDir)}'
$OwnedEntries = @(${ownedEntries})
$PrimaryRestartMode = '${escapePowerShell(input.restartMode)}'

function Write-UpdateLog([string]$Message) {
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$(Get-Date -Format o)] $Message"
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
  Write-UpdateLog 'Another portable update is already in progress.'
  Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
  exit 20
}

function Close-UpdateLock {
  if ($null -ne $UpdateLock) {
    $UpdateLock.Dispose()
    $UpdateLock = $null
  }
}

function Convert-ExtendedPath([string]$Value) {
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
}

$PortableRoot = Convert-ExtendedPath $PortableRoot
$ArchivePath = Convert-ExtendedPath $ArchivePath

function Normalize-PathForCompare([string]$Value) {
  return Convert-ExtendedPath $Value
}

function Test-UnderPortableRoot([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  $candidatePath = Normalize-PathForCompare $Candidate
  $rootPath = Normalize-PathForCompare $PortableRoot
  return $candidatePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    $candidatePath.StartsWith("$rootPath$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)
}

function Stop-PortableProcesses {
  $targets = Get-CimInstance Win32_Process | Where-Object { Test-UnderPortableRoot $_.ExecutablePath }
  foreach ($target in $targets) {
    if ($target.ProcessId -ne $PID) {
      Write-UpdateLog "Stopping portable process $($target.ProcessId): $($target.ExecutablePath)"
      Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 1500
}

function Get-PortableRunState {
  $viewerRunning = $false
  $agentRunning = $false
  $targets = Get-CimInstance Win32_Process | Where-Object { Test-UnderPortableRoot $_.ExecutablePath }
  foreach ($target in $targets) {
    $leaf = [System.IO.Path]::GetFileName($target.ExecutablePath)
    $agentMode = $leaf -ieq 'WonRemote Agent.exe' -or [string]$target.CommandLine -match '(?i)(^|\\s)--agent(\\s|$)'
    if ($agentMode) { $agentRunning = $true }
    elseif ($leaf -ieq 'WonRemote Viewer.exe') { $viewerRunning = $true }
  }
  return [PSCustomObject]@{ Viewer = $viewerRunning; Agent = $agentRunning }
}

function Remove-OwnedEntries([string]$Root) {
  foreach ($entry in $OwnedEntries) {
    $target = Join-Path $Root $entry
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $target) {
      throw "Portable update could not remove owned entry: $target"
    }
  }
}

function Remove-TreeStrict([string]$Target) {
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $Target) {
    throw "Portable update could not remove stale work directory: $Target"
  }
}

function Copy-OwnedEntries([string]$SourceRoot, [string]$DestinationRoot) {
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  foreach ($entry in $OwnedEntries) {
    $source = Join-Path $SourceRoot $entry
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $DestinationRoot $entry) -Recurse -Force
    }
  }
}

function Start-PortableRuntimes([bool]$StartViewer, [bool]$StartAgent) {
  $started = @()
  if ($StartViewer) {
    $viewer = Join-Path $PortableRoot 'WonRemote Viewer.exe'
    if (-not (Test-Path -LiteralPath $viewer -PathType Leaf)) {
      throw "Updated portable Viewer is missing: $viewer"
    }
    Write-UpdateLog "Starting portable Viewer: $viewer"
    $started += Start-Process -FilePath $viewer -PassThru
  }
  if ($StartAgent) {
    $agent = Join-Path $PortableRoot 'WonRemote Agent.exe'
    if (-not (Test-Path -LiteralPath $agent -PathType Leaf)) {
      throw "Updated portable Agent is missing: $agent"
    }
    Write-UpdateLog "Starting portable Agent: $agent --agent"
    $started += Start-Process -FilePath $agent -ArgumentList @('--agent') -PassThru
  }
  return $started
}

function Test-PortableAgentRuntime {
  $agentNode = Get-CimInstance Win32_Process | Where-Object {
    (Test-UnderPortableRoot $_.ExecutablePath) -and
    [System.IO.Path]::GetFileName($_.ExecutablePath) -ieq 'node.exe' -and
    [string]$_.CommandLine -match '(?i)[\\\\/]agent[\\\\/]index\\.mjs' -and
    [string]$_.CommandLine -match '(?i)(^|\\s)--watch(\\s|$)'
  } | Select-Object -First 1
  return $null -ne $agentNode
}

function Test-PortableRuntimes([object[]]$ExpectedProcesses, [bool]$ExpectAgent) {
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

$startedProcesses = @()
$processesStopped = $false
$backupReady = $false
try {
  Set-Location $env:TEMP
  Remove-TreeStrict $StagingDir
  Remove-TreeStrict $BackupDir
  New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StagingDir -Force

  $markerPath = Join-Path $StagingDir '${PORTABLE_MARKER_FILENAME}'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw 'Downloaded portable archive is missing its package marker.'
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.schemaVersion -ne 1 -or $marker.packageKind -ne $ExpectedPackageKind -or $marker.version -ne $ExpectedVersion) {
    throw "Downloaded portable marker mismatch: kind=$($marker.packageKind), version=$($marker.version)"
  }
  $requiredEntries = @('runtime', 'agent', 'bin', 'WonRemote Agent.exe')
  if ($ExpectedPackageKind -eq 'portable') { $requiredEntries += 'WonRemote Viewer.exe' }
  foreach ($required in $requiredEntries) {
    if (-not (Test-Path -LiteralPath (Join-Path $StagingDir $required))) {
      throw "Downloaded portable archive is missing $required."
    }
  }

  $runState = Get-PortableRunState
  $restartViewer = [bool]$runState.Viewer -or $PrimaryRestartMode -eq 'viewer'
  $restartAgent = [bool]$runState.Agent -or $PrimaryRestartMode -eq 'agent'
  if ($ExpectedPackageKind -eq 'portable-agent') { $restartViewer = $false }
  Stop-PortableProcesses
  $processesStopped = $true
  Copy-OwnedEntries $PortableRoot $BackupDir
  $backupReady = $true
  Remove-OwnedEntries $PortableRoot
  Copy-OwnedEntries $StagingDir $PortableRoot
  $startedProcesses = @(Start-PortableRuntimes $restartViewer $restartAgent)
  Start-Sleep -Seconds 12
  if (-not (Test-PortableRuntimes $startedProcesses $restartAgent)) {
    throw 'Updated portable runtime exited during the verification window.'
  }

  Write-UpdateLog "Portable update to $ExpectedVersion completed successfully."
  Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
  Close-UpdateLock
  exit 0
} catch {
  Write-UpdateLog "Portable update failed: $($_.Exception.Message)"
  if ($backupReady) {
    try {
      Stop-PortableProcesses
      Remove-OwnedEntries $PortableRoot
      Copy-OwnedEntries $BackupDir $PortableRoot
      $startedProcesses = @(Start-PortableRuntimes $restartViewer $restartAgent)
      Write-UpdateLog 'Previous portable version restored and restarted.'
    } catch {
      Write-UpdateLog "Portable rollback restart failed: $($_.Exception.Message)"
    }
  } elseif ($processesStopped) {
    try {
      $startedProcesses = @(Start-PortableRuntimes $restartViewer $restartAgent)
      Write-UpdateLog 'Existing portable version restarted after a pre-replacement failure.'
    } catch {
      Write-UpdateLog "Existing portable restart failed: $($_.Exception.Message)"
    }
  }
  Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Close-UpdateLock
  exit 1
}
`;
}

function validatePortableRoot(value: string): string {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || !path.isAbsolute(resolved)) {
    throw new Error("Portable update root must be a non-root absolute directory.");
  }
  return resolved;
}

function safePortableArchiveName(assetName: string): string {
  const basename = path.basename(assetName).replace(/[<>:"|?*]/g, "_");
  if (!basename.toLowerCase().endsWith(".zip")) {
    throw new Error("Portable update asset must be a ZIP archive.");
  }
  return basename;
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
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
