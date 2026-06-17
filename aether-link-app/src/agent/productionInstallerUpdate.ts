import { createHash } from "node:crypto";
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
};

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
  const installerPath = path.join(updatesDir, safeInstallerName(metadata));
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

  const logPath = path.join(updatesDir, "installer-handoff.log");
  const scriptPath = path.join(updatesDir, "run-installer-update.ps1");
  await writeFile(
    scriptPath,
    buildInstallerHandoffScript({
      installerArgs: download.installerArgs,
      installerPath: download.installerPath,
      logPath,
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
  logPath: string;
}): string {
  const quotedArgs = input.installerArgs.map((arg) => `'${escapePowerShellSingleQuoted(arg)}'`).join(", ");
  const quotedExplicitInstallRoots = installerInstallRootsForHandoff(input.installerArgs)
    .map((root) => `'${escapePowerShellSingleQuoted(root)}'`)
    .join(", ");

  return `$ErrorActionPreference = 'Stop'
$LogPath = '${escapePowerShellSingleQuoted(input.logPath)}'
$explicitInstallRoots = @(${quotedExplicitInstallRoots})
function Write-HandoffLog([string]$Message) {
  $stamp = Get-Date -Format o
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$stamp] $Message"
}

function Normalize-PathForCompare([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  try {
    return [System.IO.Path]::GetFullPath($Value).TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
  } catch {
    return $Value.TrimEnd("\\", "/")
  }
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
  $roots = @(
    "$env:LOCALAPPDATA\\WonRemote Viewer",
    "$env:LOCALAPPDATA\\WonRemote Agent",
    "$env:LOCALAPPDATA\\WonRemote\\Viewer",
    "$env:LOCALAPPDATA\\WonRemote\\Agent"
  )
  $roots = @($roots + $explicitInstallRoots) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
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

function Test-WonRemoteAgentRunning([string[]]$Roots) {
  $target = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -ieq "wonremote-viewer.exe" -or $_.Name -ieq "WonRemote Agent.exe") -and
    (Test-UnderPath $_.ExecutablePath $Roots)
  } | Select-Object -First 1
  return $null -ne $target
}

function Start-WonRemoteAgent {
  $roots = @(
    $explicitInstallRoots,
    "$env:LOCALAPPDATA\\WonRemote Agent",
    "$env:LOCALAPPDATA\\WonRemote Viewer",
    "$env:LOCALAPPDATA\\WonRemote\\Agent",
    "$env:LOCALAPPDATA\\WonRemote\\Viewer"
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  if (Test-WonRemoteAgentRunning $roots) {
    Write-HandoffLog "WonRemote Agent is already running after installer exit; skipping fallback start."
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

try {
  $installerPath = '${escapePowerShellSingleQuoted(input.installerPath)}'
  $installerArgs = @(${quotedArgs})
  Stop-WonRemoteProcesses
  Write-HandoffLog "Starting installer update: $installerPath $($installerArgs -join ' ')"
  $process = Start-Process -FilePath $installerPath -ArgumentList $installerArgs -WindowStyle Hidden -PassThru
  Write-HandoffLog "Installer PID: $($process.Id)"
  $process.WaitForExit()
  Write-HandoffLog "Installer exit code: $($process.ExitCode)"
  if ($process.ExitCode -eq 0) {
    Start-WonRemoteAgent
  }
  exit $process.ExitCode
} catch {
  Write-HandoffLog "Installer handoff failed: $($_.Exception.Message)"
  exit 1
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
