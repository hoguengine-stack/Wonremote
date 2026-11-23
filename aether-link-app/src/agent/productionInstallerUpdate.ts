import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  installerSha256: string;
};

export type InstallerHandoffResult = {
  args: string[];
  command: string;
  creationFlags: number;
  installerPath: string;
  installerSha256: string;
  logPath: string;
  protectedAcknowledgementPath?: string;
  requestId: string;
  scriptSha256: string;
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
  onProgress?: (progress: { downloadedBytes: number; totalBytes?: number }) => void;
};

type PrepareInstallerHandoffOptions = {
  baseDir: string;
  restartExecutablePath?: string;
  restartMode?: InstallerRestartMode;
  targetVersion?: string;
  legacyRollback?: boolean;
  legacyFirstHop?: boolean;
};

export type InstallerRestartMode = "agent" | "viewer";

const CREATE_NO_WINDOW = 0x08000000;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
export const INSTALLER_HANDOFF_CREATION_FLAGS = CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB;
export const UPDATE_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const FAILED_ROLLBACK_MARKER = "ROLLBACK_FAILED";

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

  const expectedChecksum = metadata.checksum.toLowerCase();
  const updatesDir = path.join(options.baseDir, "WonRemote", "updates");
  await mkdir(updatesDir, { recursive: true });
  await cleanupInstallerUpdateArtifacts(updatesDir);
  const safeName = safeInstallerName(metadata);
  const installerPath = path.join(updatesDir, `${safeName.slice(0, -4)}-${expectedChecksum.slice(0, 12)}.exe`);
  const partialPath = `${installerPath}.part`;

  if (await fileMatchesChecksum(installerPath, expectedChecksum)) {
    return {
      installerArgs: installerArgsForUpdate(metadata),
      installerPath,
      installerSha256: expectedChecksum,
    };
  }
  await rm(installerPath, { force: true });

  const existingBytes = await fileSize(partialPath);
  await downloadToPartialFile(metadata.downloadUrl, partialPath, existingBytes, options);
  const actualChecksum = await sha256File(partialPath);
  if (actualChecksum !== expectedChecksum) {
    await rm(partialPath, { force: true });
    throw new Error(`Installer checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  }
  await rename(partialPath, installerPath);

  return {
    installerArgs: installerArgsForUpdate(metadata),
    installerPath,
    installerSha256: expectedChecksum,
  };
}

async function downloadToPartialFile(
  downloadUrl: string,
  partialPath: string,
  existingBytes: number,
  options: DownloadInstallerOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : undefined;
  let response = await fetchImpl(downloadUrl, { headers });
  if (response.status === 416 && existingBytes > 0) {
    await rm(partialPath, { force: true });
    response = await fetchImpl(downloadUrl);
    existingBytes = 0;
  }
  if (!response.ok || !response.body) {
    throw new Error(`Installer download failed: HTTP ${response.status}`);
  }

  const isResumed = existingBytes > 0 && response.status === 206;
  if (response.status === 206 && !contentRangeStartsAt(response.headers.get("content-range"), existingBytes)) {
    throw new Error("Installer resume response had an invalid Content-Range.");
  }
  const startingBytes = isResumed ? existingBytes : 0;
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(contentLength) ? startingBytes + contentLength : undefined;
  let downloadedBytes = startingBytes;
  const source = Readable.fromWeb(response.body as never);
  source.on("data", (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    options.onProgress?.({ downloadedBytes, totalBytes });
  });
  await pipeline(source, createWriteStream(partialPath, { flags: isResumed ? "a" : "w" }));
}

export async function cleanupInstallerUpdateArtifacts(
  updatesDir: string,
  nowMs = Date.now(),
  retentionMs = UPDATE_ARTIFACT_RETENTION_MS,
): Promise<void> {
  const entries = await readdir(updatesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(updatesDir, entry.name);
    const info = await stat(entryPath).catch(() => null);
    if (!info || nowMs - info.mtimeMs < retentionMs) continue;
    if (entry.isDirectory() && entry.name.startsWith("rollback-")) {
      const retained = await stat(path.join(entryPath, FAILED_ROLLBACK_MARKER)).then(() => true).catch(() => false);
      if (!retained) await rm(entryPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isFile() && /\.(?:part|exe|ps1|log|accepted)$/i.test(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
}

async function fileMatchesChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  return sha256File(filePath).then((value) => value === expectedChecksum).catch(() => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fileSize(filePath: string): Promise<number> {
  return stat(filePath).then((value) => value.size).catch(() => 0);
}

function contentRangeStartsAt(value: string | null, expectedStart: number): boolean {
  const match = /^bytes (\d+)-\d+\/\d+$/.exec(value ?? "");
  return Boolean(match && Number(match[1]) === expectedStart);
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
  const installerSha256 = await sha256File(download.installerPath);
  if (installerSha256 !== download.installerSha256.toLowerCase()) {
    throw new Error("Installer changed after checksum verification.");
  }
  const script = buildInstallerHandoffScript({
    installerArgs: download.installerArgs,
    installerPath: download.installerPath,
    lockPath: path.join(updatesDir, "update-handoff.lock"),
    logPath,
    restartExecutablePath: options.restartExecutablePath,
    restartMode: options.restartMode ?? "agent",
    targetVersion: options.targetVersion,
    legacyRollback: options.legacyRollback,
    legacyFirstHop: options.legacyFirstHop,
  });
  const scriptSha256 = createHash("sha256").update(script, "utf8").digest("hex");
  await writeFile(scriptPath, script, "utf8");

  const protectedAcknowledgementPath = options.restartMode !== "viewer" && options.restartExecutablePath
    ? path.join(
        path.dirname(options.restartExecutablePath),
        ".update-handoff",
        updateId,
        "installer-started.accepted",
      )
    : undefined;

  return {
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    command: "powershell.exe",
    creationFlags: INSTALLER_HANDOFF_CREATION_FLAGS,
    installerPath: download.installerPath,
    installerSha256,
    logPath,
    ...(protectedAcknowledgementPath ? { protectedAcknowledgementPath } : {}),
    requestId: updateId,
    scriptSha256,
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
  targetVersion?: string;
  legacyRollback?: boolean;
  legacyFirstHop?: boolean;
}): string {
  const quotedArgs = input.installerArgs.map((arg) => `'${escapePowerShellSingleQuoted(arg)}'`).join(", ");
  const quotedExplicitInstallRoots = installerInstallRootsForHandoff(input.installerArgs)
    .map((root) => `'${escapePowerShellSingleQuoted(root)}'`)
    .join(", ");
  const restartCommand = input.restartMode === "viewer" ? "Start-WonRemoteViewer" : "Start-WonRemoteAgent";

  return `$ErrorActionPreference = 'Stop'
$LogPath = '${escapePowerShellSingleQuoted(input.logPath)}'
$OriginalInstallerPath = '${escapePowerShellSingleQuoted(input.installerPath)}'
$InstallerPath = if ([string]::IsNullOrWhiteSpace($env:WONREMOTE_HANDOFF_INSTALLER_PATH)) { $OriginalInstallerPath } else { $env:WONREMOTE_HANDOFF_INSTALLER_PATH }
$AcceptedPath = if ([string]::IsNullOrWhiteSpace($env:WONREMOTE_HANDOFF_ACCEPTED_PATH)) { $PSCommandPath + '.accepted' } else { $env:WONREMOTE_HANDOFF_ACCEPTED_PATH }
$InstallerArgs = @(${quotedArgs})
$LockPath = '${escapePowerShellSingleQuoted(input.lockPath)}'
$RestartMode = '${escapePowerShellSingleQuoted(input.restartMode)}'
$RestartExecutablePath = '${escapePowerShellSingleQuoted(input.restartExecutablePath ?? "")}'
$TargetVersion = '${escapePowerShellSingleQuoted(input.targetVersion ?? "")}'
$LegacyRollback = $${input.legacyRollback === true}
$LegacyFirstHop = $${input.legacyFirstHop === true}
if ($LegacyFirstHop) { $env:PSModulePath = "$PSHOME\\Modules" }
$UpdateStarted = [datetime]::UtcNow
$IdentityBeforeUpdate = $null
$ResultPath = Join-Path (Split-Path -Parent $OriginalInstallerPath) 'last-update-result.json'
$explicitInstallRoots = @(${quotedExplicitInstallRoots})
$RollbackRoot = Join-Path (Split-Path -Parent $OriginalInstallerPath) ('rollback-' + [guid]::NewGuid().ToString())
$script:RollbackEntries = @()
$FailureExitCode = 1
$InstallerStarted = $false
function Write-HandoffLog([string]$Message) {
  $stamp = Get-Date -Format o
  # Diagnostic log contention must never interrupt installation or rollback.
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$stamp] $Message" -ErrorAction SilentlyContinue
}

function Write-UpdateResult([string]$State, [string]$ErrorMessage) {
  @{ state = $State; error = $ErrorMessage; targetVersion = $TargetVersion; updatedAt = (Get-Date -Format o) } |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath $ResultPath -Encoding UTF8
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
  $brokeredRoot = Get-BrokeredAgentInstallRoot
  if ($brokeredRoot) { return $brokeredRoot }
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

function Get-BrokeredAgentInstallRoot {
  if ($RestartMode -ne 'agent') { return }
  $handoff = Split-Path -Parent $PSScriptRoot
  if ((Split-Path -Leaf $handoff) -eq '.update-handoff') {
    return Split-Path -Parent $handoff
  }
}

function Assert-TrustedRollbackDirectory([string]$Path, [string[]]$ProtectedRoots) {
  $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $write = [int][Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership' -bor 0x50000000
  $item = Get-Item -LiteralPath $Path -Force
  while ($item -and (Test-UnderPath $item.FullName $ProtectedRoots)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Rollback cannot traverse a reparse point: $($item.FullName)" }
    $acl = Get-Acl -LiteralPath $item.FullName
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) {
      throw "Rollback directory has an untrusted owner: $($item.FullName)"
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      $sid = $rule.IdentityReference.Value
      if ($sid -eq 'S-1-3-0' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
      if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $trusted -and ([int]$rule.FileSystemRights -band $write)) {
        throw "Rollback directory is user-writable: $($item.FullName)"
      }
    }
    $item = $item.Parent
  }
}

function Assert-WonRemoteRollbackBoundary([string[]]$InstallRoots) {
  if ($RestartMode -ne 'agent') { return }
  $protectedRoots = @($env:ProgramFiles, \${env:ProgramFiles(x86)})
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  $protectedInstall = @($InstallRoots | Where-Object { Test-UnderPath $_ $protectedRoots }).Count -gt 0
  if (-not ($protectedInstall -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) { return }
  if (-not (Test-UnderPath $RollbackRoot $protectedRoots) -or
      @($InstallRoots | Where-Object { -not (Test-UnderPath $_ $protectedRoots) }).Count -gt 0) {
    throw 'Refusing privileged rollback from or into a user-writable legacy installation; use the protected Agent update task.'
  }
  $backupDirectory = if (Test-Path -LiteralPath $RollbackRoot -PathType Container) { $RollbackRoot } else { Split-Path -Parent $RollbackRoot }
  Assert-TrustedRollbackDirectory $backupDirectory $protectedRoots
  foreach ($root in $InstallRoots) { Assert-TrustedRollbackDirectory $root $protectedRoots }
}

function Backup-WonRemoteInstall {
  if ($RestartMode -eq 'agent') {
    $configPath = Join-Path (Split-Path -Parent (Split-Path -Parent $OriginalInstallerPath)) 'agent-config.json'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
      $script:IdentityBeforeUpdate = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    # Privileged rollback copies must not be writable through the user's download directory.
    if (Test-UnderPath $PSScriptRoot @($env:ProgramFiles, \${env:ProgramFiles(x86)})) {
      $script:RollbackRoot = Join-Path $PSScriptRoot ('rollback-' + [guid]::NewGuid().ToString())
    }
  }
  $roots = @(Get-WonRemoteInstallRoots | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  Assert-WonRemoteRollbackBoundary $roots
  New-Item -ItemType Directory -Path $RollbackRoot -Force | Out-Null
  $pendingEntries = @()
  $index = 0
  try {
    foreach ($root in $roots) {
      $backupPath = Join-Path $RollbackRoot ([string]$index)
      New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
      Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -ne '.update-handoff' } |
        Copy-Item -Destination $backupPath -Recurse -Force
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

function Get-WonRemoteRollbackFileHash([string]$Path) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $file = [IO.File]::OpenRead($Path)
    try { [BitConverter]::ToString($sha256.ComputeHash($file)).Replace('-', '') }
    finally { $file.Dispose() }
  } finally { $sha256.Dispose() }
}

function Restore-WonRemoteInstall {
  if ($script:RollbackEntries.Count -eq 0) {
    throw 'No previous WonRemote installation was available to restore.'
  }
  Assert-WonRemoteRollbackBoundary @($script:RollbackEntries | ForEach-Object Root)
  $stage = Join-Path $RollbackRoot ('restore-' + [guid]::NewGuid().ToString('N'))
  $changes = [Collections.Generic.List[object]]::new()
  $lockChecks = [Collections.Generic.List[string]]::new()
  $verifiedFiles = [Collections.Generic.List[object]]::new()
  $applied = [Collections.Generic.List[object]]::new()
  $keepRecovery = $false
  try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($entry in $script:RollbackEntries) {
      if (-not (Test-Path -LiteralPath $entry.Backup -PathType Container)) {
        throw "Rollback backup is missing: $($entry.Backup)"
      }
      $backupItems = @(Get-ChildItem -LiteralPath $entry.Backup -Recurse -Force | Sort-Object { $_.FullName.Length })
      if (-not @($backupItems | Where-Object { -not $_.PSIsContainer }).Count) {
        throw "Rollback backup is empty: $($entry.Backup)"
      }
      if (-not (Test-Path -LiteralPath $entry.Root -PathType Container)) {
        $changes.Add([pscustomobject]@{ Kind = 'directory'; Target = $entry.Root; Applied = $false })
      }
      foreach ($item in $backupItems) {
        $relative = $item.FullName.Substring($entry.Backup.TrimEnd('\\').Length + 1)
        $target = Join-Path $entry.Root $relative
        $existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($existing -and (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $existing.PSIsContainer -ne $item.PSIsContainer))) {
          throw "Rollback file type or path differs: $target"
        }
        if ($item.PSIsContainer) {
          if (-not $existing) { $changes.Add([pscustomobject]@{ Kind = 'directory'; Target = $target; Applied = $false }) }
          continue
        }
        $expectedHash = Get-WonRemoteRollbackFileHash $item.FullName
        $verifiedFiles.Add([pscustomobject]@{ Path = $target; Hash = $expectedHash })
        if ($existing -and (Get-WonRemoteRollbackFileHash $target) -ceq $expectedHash) { continue }
        $pending = Join-Path $stage ([string]$changes.Count)
        Copy-Item -LiteralPath $item.FullName -Destination $pending -Force
        if ((Get-WonRemoteRollbackFileHash $pending) -cne $expectedHash) { throw "Staged rollback file changed: $target" }
        if ($existing) { $lockChecks.Add($target) }
        $changes.Add([pscustomobject]@{
          Kind = 'file'; Target = $target; Stage = $pending; Replace = [bool]$existing; Applied = $false
          Next = $target + '.' + [guid]::NewGuid().ToString('N') + '.rollback-tmp'
          Previous = $target + '.' + [guid]::NewGuid().ToString('N') + '.rollback-undo'
        })
      }
      if (-not (Test-Path -LiteralPath $entry.Root -PathType Container)) { continue }
      $obsolete = [Collections.Generic.List[string]]::new()
      $installed = @(Get-ChildItem -LiteralPath $entry.Root -Force | Where-Object { $_.Name -ne '.update-handoff' } | ForEach-Object {
        $_
        if ($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          Get-ChildItem -LiteralPath $_.FullName -Recurse -Force
        }
      } | Sort-Object { $_.FullName.Length })
      foreach ($item in $installed) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Rollback cannot traverse a reparse point: $($item.FullName)" }
        $relative = $item.FullName.Substring($entry.Root.TrimEnd('\\').Length + 1)
        if (Test-Path -LiteralPath (Join-Path $entry.Backup $relative)) { continue }
        if (-not $item.PSIsContainer) { $lockChecks.Add($item.FullName) }
        if (Test-UnderPath $item.FullName $obsolete.ToArray()) { continue }
        $obsolete.Add($item.FullName)
        $changes.Add([pscustomobject]@{
          Kind = 'obsolete'; Target = $item.FullName; Directory = $item.PSIsContainer
          Previous = $item.FullName + '.' + [guid]::NewGuid().ToString('N') + '.rollback-undo'
        })
      }
    }

    # Staging does not interrupt the runtime. Release its own image handles before probing
    # the files that must change. A matching capture executable need not be opened exclusively.
    Stop-WonRemoteProcesses
    foreach ($target in $lockChecks) {
      [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None).Dispose()
    }
    foreach ($change in $changes) {
      $applied.Add($change)
      switch ($change.Kind) {
        'directory' {
          New-Item -ItemType Directory -Path $change.Target | Out-Null
          $change.Applied = $true
        }
        'file' {
          Copy-Item -LiteralPath $change.Stage -Destination $change.Next -Force
          if ($change.Replace) {
            [IO.File]::Replace($change.Next, $change.Target, $change.Previous)
          } else {
            [IO.File]::Move($change.Next, $change.Target)
            $change.Applied = $true
          }
        }
        'obsolete' {
          if ($change.Directory) { [IO.Directory]::Move($change.Target, $change.Previous) }
          else { [IO.File]::Move($change.Target, $change.Previous) }
        }
      }
    }
    foreach ($file in $verifiedFiles) {
      if ((Get-WonRemoteRollbackFileHash $file.Path) -cne $file.Hash) { throw "Restored file did not verify: $($file.Path)" }
    }
  } catch {
    $failure = $_
    for ($index = $applied.Count - 1; $index -ge 0; $index--) {
      $change = $applied[$index]
      try {
        switch ($change.Kind) {
          'directory' { if ($change.Applied) { [IO.Directory]::Delete($change.Target) } }
          'file' {
            if ([IO.File]::Exists($change.Previous)) {
              if ([IO.File]::Exists($change.Target)) {
                [IO.File]::Replace($change.Previous, $change.Target, [NullString]::Value)
              } else { [IO.File]::Move($change.Previous, $change.Target) }
            } elseif ($change.Applied) { [IO.File]::Delete($change.Target) }
          }
          'obsolete' {
            if ([IO.Directory]::Exists($change.Previous)) { [IO.Directory]::Move($change.Previous, $change.Target) }
            elseif ([IO.File]::Exists($change.Previous)) { [IO.File]::Move($change.Previous, $change.Target) }
          }
        }
      } catch {
        $keepRecovery = $true
        Write-HandoffLog "Could not undo rollback change for $($change.Target): $($_.Exception.Message)"
      }
    }
    if ($keepRecovery) { throw "Rollback undo was incomplete; recovery files were retained. $($failure.Exception.Message)" }
    throw $failure
  } finally {
    foreach ($change in $applied) {
      if ($change.Kind -eq 'file' -and [IO.File]::Exists($change.Next)) {
        Remove-Item -LiteralPath $change.Next -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not $keepRecovery -and (Test-UnderPath $stage @($RollbackRoot)) -and (Test-Path -LiteralPath $stage)) {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($entry in $script:RollbackEntries) { Write-HandoffLog "Restored WonRemote install root: $($entry.Root)" }
  $rollbackStarted = [datetime]::UtcNow
  if ($LegacyFirstHop) { Start-WonRemoteFirstHopCaptureTask }
  ${restartCommand}
  if ($RestartMode -eq 'agent') {
    Wait-WonRemoteAgentRuntime
    if ($LegacyFirstHop) {
      Assert-WonRemoteFirstHopIdentity
      Wait-WonRemoteAgentOnline '0.1.123' $rollbackStarted
    }
  } else {
    Wait-WonRemoteViewer
  }
  foreach ($change in $applied) {
    if ($change.Kind -ne 'directory' -and (Test-Path -LiteralPath $change.Previous)) {
      try { Remove-Item -LiteralPath $change.Previous -Recurse -Force -ErrorAction Stop }
      catch { Write-HandoffLog "Restored runtime is healthy; retained recovery path $($change.Previous): $($_.Exception.Message)" }
    }
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
  $brokeredRoot = Get-BrokeredAgentInstallRoot
  if ($brokeredRoot) { return $brokeredRoot }
  return @(
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'WonRemote Agent' }),
    $(if (\${env:ProgramFiles(x86)}) { Join-Path \${env:ProgramFiles(x86)} 'WonRemote Agent' }),
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
  $deadline = (Get-Date).AddSeconds(60)
  do {
    if (Test-WonRemoteAgentRuntime $roots) {
      Write-HandoffLog 'WonRemote Agent node runtime health check passed.'
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'WonRemote Agent shell started, but its node.exe agent/index.mjs --watch runtime did not stay alive.'
}

function Assert-WonRemoteFirstHopIdentity {
  $root = Get-BrokeredAgentInstallRoot
  if ($RestartMode -cne 'agent' -or -not $root -or -not $RestartExecutablePath -or
      (Normalize-PathForCompare $RestartExecutablePath) -ine (Normalize-PathForCompare (Join-Path $root 'wonremote-viewer.exe')) -or
      (Get-Item -LiteralPath $RestartExecutablePath).VersionInfo.ProductVersion -cne '0.1.123' -or
      [string]::IsNullOrWhiteSpace([string]$IdentityBeforeUpdate.registeredDeviceId) -or
      [string]::IsNullOrWhiteSpace([string]$IdentityBeforeUpdate.installId)) {
    throw 'First hop requires the original enrolled Agent 0.1.123 under the protected handoff.'
  }
  $configPath = Join-Path (Split-Path -Parent (Split-Path -Parent $OriginalInstallerPath)) 'agent-config.json'
  $current = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($current.registeredDeviceId -cne $IdentityBeforeUpdate.registeredDeviceId -or
      $current.installId -cne $IdentityBeforeUpdate.installId) {
    throw 'The original Agent registration changed during the protected first hop.'
  }
}

function Start-WonRemoteFirstHopCaptureTask {
  $root = Get-BrokeredAgentInstallRoot
  if (-not $root) { throw 'First hop requires the original protected capture task.' }
  $task = Get-ScheduledTask -TaskPath '\\' -TaskName 'WonRemote Secure Capture'
  $actions = @($task.Actions)
  if ($actions.Count -ne 1 -or $actions[0].Execute -ine (Join-Path $root 'bin\\wonremote-poc.exe') -or
      $actions[0].Arguments -cne '--mode secure-broker' -or $task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or
      $task.Principal.LogonType -ne 'ServiceAccount' -or $task.Principal.RunLevel -ne 'Highest' -or
      -not $task.Settings.Enabled -or -not $task.Settings.AllowDemandStart -or $task.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'The original protected capture task no longer verifies.'
  }
  Start-ScheduledTask -InputObject $task
}

function Wait-WonRemoteAgentOnline([string]$Version = $TargetVersion, $Since = $UpdateStarted) {
  if (-not $LegacyFirstHop -and $LegacyRollback -and [version]$Version -le [version]'0.1.104') {
    Write-HandoffLog 'Explicit legacy rollback: this release predates online receipts; only runtime recovery is confirmed.'
    return
  }
  $root = @(Get-WonRemoteAgentRoots) | Where-Object {
    (Test-UnderPath $_ @($env:ProgramFiles, \${env:ProgramFiles(x86)})) -and
    (Test-Path -LiteralPath (Join-Path $_ 'agent-update-health.ps1') -PathType Leaf)
  } | Select-Object -First 1
  if (-not $root -or [string]::IsNullOrWhiteSpace($Version)) {
    throw 'Installed Agent online verifier or target version is missing.'
  }
  . (Join-Path $root 'agent-update-health.ps1')
  $receiptPath = Join-Path (Split-Path -Parent (Split-Path -Parent $OriginalInstallerPath)) 'agent-online.json'
  Wait-AgentSecureCaptureTask $root
  Wait-AgentOnlineReceipt $receiptPath $root $Version $IdentityBeforeUpdate $Since
  Write-HandoffLog 'WonRemote Agent target version, identity, secure capture, accepted heartbeat and command round trip verified.'
}

function Start-WonRemoteAgent {
  if ($LegacyFirstHop) {
    $root = Get-BrokeredAgentInstallRoot
    if (-not $root) { throw 'First hop requires the original scheduled Agent.' }
    $task = Get-ScheduledTask -TaskPath '\\' -TaskName 'WonRemote Agent'
    $actions = @($task.Actions)
    $account = [string]$task.Principal.UserId
    $sid = if ($account -match '^S-1-') { $account } else {
      ([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($actions.Count -ne 1 -or $actions[0].Execute -ine (Join-Path $root 'wonremote-viewer.exe') -or
        $actions[0].Arguments -cne '--agent' -or $actions[0].WorkingDirectory -ine $root -or
        $sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        $task.Principal.RunLevel -ne 'Highest' -or $task.Principal.LogonType -ne 'Interactive' -or
        -not $task.Settings.Enabled -or -not $task.Settings.AllowDemandStart -or
        $task.State -notin @('Ready','Running')) {
      throw 'The original scheduled Agent no longer verifies.'
    }
    if ($task.State -eq 'Ready') { Start-ScheduledTask -InputObject $task }
    return
  }
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
  if ($LegacyFirstHop) {
    Assert-WonRemoteFirstHopIdentity
    Wait-WonRemoteAgentOnline '0.1.123' ([datetime]::new(0, [DateTimeKind]::Utc))
  }
  # The accepted installer owns process shutdown. Keep the current Agent alive while Windows approval is pending.
  Write-HandoffLog "Starting installer update: $InstallerPath $($InstallerArgs -join ' ')"
  $previousTemp = $env:TEMP
  $previousTmp = $env:TMP
  try {
    if ($LegacyFirstHop) {
      $installerTemp = Join-Path $PSScriptRoot 'installer-temp'
      New-Item -ItemType Directory -Path $installerTemp | Out-Null
      Assert-TrustedRollbackDirectory $installerTemp @($env:ProgramFiles, \${env:ProgramFiles(x86)})
      $env:TEMP = $installerTemp
      $env:TMP = $installerTemp
    }
    $process = Start-Process -FilePath $InstallerPath -ArgumentList $InstallerArgs -WindowStyle Hidden -PassThru
  } finally {
    if ($LegacyFirstHop) {
      $env:TEMP = $previousTemp
      $env:TMP = $previousTmp
    }
  }
  $InstallerStarted = $true
  Set-Content -LiteralPath $AcceptedPath -Encoding ASCII -Value 'installer-started'
  Write-HandoffLog "Installer PID: $($process.Id)"
  $process.WaitForExit()
  Write-HandoffLog "Installer exit code: $($process.ExitCode)"
  if ($process.ExitCode -ne 0) {
    $FailureExitCode = $process.ExitCode
    throw "Installer exited with code $($process.ExitCode)."
  }
  if ($LegacyFirstHop) { Start-WonRemoteFirstHopCaptureTask }
  ${restartCommand}
  if ($RestartMode -eq 'agent') {
    Wait-WonRemoteAgentRuntime
    Wait-WonRemoteAgentOnline
  } else {
    Wait-WonRemoteViewer
  }
  Remove-WonRemoteRollback
  Write-UpdateResult 'healthy' ''
  Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
  if (-not $InstallerPath.Equals($OriginalInstallerPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $OriginalInstallerPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath ($InstallerPath + '.part') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $AcceptedPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  Close-UpdateLock
  exit 0
} catch {
  $installError = [string]$_.Exception.Message
  $rollbackError = 'No complete rollback backup was available.'
  Write-HandoffLog "Installer handoff failed: $installError"
  if (-not $InstallerStarted) {
    # No installer changed the installation; rollback would needlessly stop the working runtime.
    Write-UpdateResult 'failed' ('Installer did not start; existing runtime preserved. ' + $_.Exception.Message)
    Remove-WonRemoteRollback
    Close-UpdateLock
    exit $FailureExitCode
  }
  $rollbackCompleted = $false
  if ($script:RollbackEntries.Count -gt 0) {
    try {
      try { Write-UpdateResult 'rollback' 'New installation failed; restoring the previous runtime. Recovery is not yet confirmed.' }
      catch { Write-HandoffLog "Could not record in-progress rollback: $($_.Exception.Message)" }
      Restore-WonRemoteInstall
      $rollbackCompleted = $true
    } catch {
      $rollbackError = [string]$_.Exception.Message
      Write-HandoffLog "Installer rollback failed: $rollbackError"
      Set-Content -LiteralPath (Join-Path $RollbackRoot '${FAILED_ROLLBACK_MARKER}') -Encoding UTF8 -Value (Get-Date -Format o) -ErrorAction SilentlyContinue
      Write-HandoffLog "Rollback backup retained for manual recovery: $RollbackRoot"
    }
  } else {
    Write-HandoffLog 'Installer was not started because no complete rollback backup was available.'
  }
  if ($rollbackCompleted) {
    Write-UpdateResult 'rollback' ('The new runtime failed and the previous version was restored. Install: ' + $installError)
    Remove-WonRemoteRollback
  } elseif ($script:RollbackEntries.Count -gt 0) {
    Write-UpdateResult 'failed' ('The installer and automatic rollback both failed. Install: ' + $installError + '; Rollback: ' + $rollbackError)
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
