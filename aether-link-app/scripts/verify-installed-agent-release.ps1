param(
  [Parameter(Mandatory)][string]$BaselineTag,
  [string]$CandidatePublicKeyFile,
  [string]$SandboxFixtureRoot
)
$ErrorActionPreference = 'Stop'

$sandboxMode = -not [string]::IsNullOrWhiteSpace($SandboxFixtureRoot)
if ($sandboxMode) {
  $guestUser = ([Security.Principal.WindowsIdentity]::GetCurrent().Name -split '\\')[-1]
  $guest = Get-CimInstance Win32_ComputerSystem
  if ($guestUser -ine 'WDAGUtilityAccount' -or $guest.Model -ine 'Virtual Machine') {
    throw 'The offline fixture must run inside Windows Sandbox, never on the host PC.'
  }
  if (-not $CandidatePublicKeyFile) { throw 'The offline fixture requires its disposable candidate public key.' }
} elseif ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'The signed installation test is only for a disposable GitHub-hosted Windows runner or a Windows Sandbox fixture.'
}
if ($BaselineTag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Expected a pinned stable baseline tag.' }
if (-not $sandboxMode -and $CandidatePublicKeyFile -and $env:GITHUB_REF -cnotmatch '^refs/heads/codex/verify-agent-install/[^/]+$') {
  throw 'A test signing key is permitted only on the verification-only branch.'
}

$app = Split-Path -Parent $PSScriptRoot
$candidate = Join-Path $app 'release-exe'
$version = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
$previous = $BaselineTag.Substring(1)
if ([version]$version -le [version]$previous) { throw 'Candidate must be newer than the published baseline.' }

$install = Join-Path ${env:ProgramFiles(x86)} 'WonRemote Agent'
$identity = Join-Path $env:APPDATA 'WonRemote\agent-install-id'
$config = Join-Path $env:APPDATA 'WonRemote\agent-config.json'
$task = 'WonRemote Agent'
if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $config) -or
    (Test-Path -LiteralPath $identity) -or (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
  throw 'Refusing to test on a runner with an existing Agent or registration.'
}

$nodeCommand = 'node'
if ($sandboxMode) {
  $baseline = Join-Path $SandboxFixtureRoot 'baseline'
  $nodeCommand = Join-Path $SandboxFixtureRoot 'node.exe'
} else {
  $baseline = Join-Path $env:RUNNER_TEMP ('wonremote-previous-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $baseline | Out-Null
  foreach ($asset in @('wonremote-update-manifest.json', 'WonRemote-Agent-Setup.exe', 'WonRemote-Agent-Update.exe', 'WonRemote-Viewer-Setup.exe')) {
    Invoke-WebRequest -Uri "https://github.com/hoguengine-stack/Wonremote/releases/download/$BaselineTag/$asset" -OutFile (Join-Path $baseline $asset) -TimeoutSec 120
  }
}

function Confirm-SignedRelease([string]$Directory, [string]$ExpectedVersion, [string]$PublicKey = '') {
  $savedKey = $env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY
  try {
    $env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = $PublicKey
    & $nodeCommand (Join-Path $PSScriptRoot 'verify-release-manifest.js') `
      --manifest (Join-Path $Directory 'wonremote-update-manifest.json') --version $ExpectedVersion `
      --agent-x64 (Join-Path $Directory 'WonRemote-Agent-Setup.exe') --viewer-x64 (Join-Path $Directory 'WonRemote-Viewer-Setup.exe')
    if ($LASTEXITCODE -ne 0) { throw "Signed manifest validation failed for $ExpectedVersion." }
  } finally {
    $env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = $savedKey
  }
}

function Invoke-Installer([string]$Path, [int]$ExpectedExit = 0) {
  $process = Start-Process -FilePath $Path -ArgumentList '/S' -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(180000)) { throw 'Installer timed out.' }
  if ($process.ExitCode -ne $ExpectedExit) { throw "Installer returned $($process.ExitCode), expected $ExpectedExit : $Path" }
}

function Confirm-InstalledVersion([string]$ExpectedVersion) {
  $hostPath = Join-Path $install 'wonremote-viewer.exe'
  if ((Get-Item -LiteralPath $hostPath).VersionInfo.ProductVersion -ne $ExpectedVersion) {
    throw "Installed Agent version did not match $ExpectedVersion."
  }
  foreach ($file in @('agent\index.mjs','runtime\node.exe','update-handoff-broker.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $install $file) -PathType Leaf)) { throw "Missing installed $file." }
  }
  $entry = Get-ScheduledTask -TaskName $task
  if ($entry.Actions.Execute -ine $hostPath -or $entry.Actions.Arguments -cne '--agent') {
    throw 'Installed scheduled task must still target the protected Agent.'
  }
}

function Confirm-AgentLaunch {
  $hostPath = Join-Path $install 'wonremote-viewer.exe'
  $started = [datetime]::Now
  Start-ScheduledTask -TaskName $task
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Get-CimInstance Win32_Process -Filter "Name = 'wonremote-viewer.exe'" | Where-Object {
      $_.ExecutablePath -ieq $hostPath -and [datetime]$_.CreationDate -ge $started
    }) { return }
    Start-Sleep -Seconds 1
  }
  throw 'The installed Agent did not launch from its scheduled task.'
}

Confirm-SignedRelease $baseline $previous
$candidateKey = if ($CandidatePublicKeyFile) { Get-Content -LiteralPath $CandidatePublicKeyFile -Raw } else { '' }
if ($CandidatePublicKeyFile -and [string]::IsNullOrWhiteSpace($candidateKey)) { throw 'The test public key is empty.' }
Confirm-SignedRelease $candidate $version $candidateKey
$env:WONREMOTE_DISABLE_FIREBASE = '1'
if (Get-NetFirewallProfile | Where-Object { $_.Enabled -ne 'True' }) {
  throw 'An enabled firewall is required to isolate the disposable Agent from the production network.'
}
foreach ($relativePath in @('wonremote-viewer.exe', 'runtime\node.exe', 'bin\wonremote-poc.exe')) {
  New-NetFirewallRule -DisplayName "WonRemote release verification $relativePath" -Direction Outbound `
    -Action Block -Program (Join-Path $install $relativePath) | Out-Null
}
Invoke-Installer (Join-Path $baseline 'WonRemote-Agent-Setup.exe')
Confirm-InstalledVersion $previous
if (Test-Path -LiteralPath $config) { throw 'The release check must not configure a live Agent.' }
if (-not (Test-Path -LiteralPath $identity)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $identity) -Force | Out-Null
  [IO.File]::WriteAllText($identity, ([guid]::NewGuid().ToString('N').Substring(0, 8).ToUpperInvariant()))
}
$identityHash = (Get-FileHash -LiteralPath $identity).Hash
$uninstaller = Join-Path $install 'uninstall.exe'
$uninstallerHash = (Get-FileHash -LiteralPath $uninstaller).Hash

$stage = Join-Path $install ('.update-handoff\' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stage | Out-Null
$stagedInstaller = Join-Path $stage 'installer.exe'
Copy-Item -LiteralPath (Join-Path $candidate 'WonRemote-Agent-Update.exe') -Destination $stagedInstaller
$env:WONREMOTE_HANDOFF_INSTALLER_PATH = $stagedInstaller

$baselineHashes = @{}
foreach ($relativePath in @('wonremote-viewer.exe','agent\index.mjs','bin\wonremote-poc.exe','runtime\node.exe','server\index.mjs')) {
  $path = Join-Path $install $relativePath
  $baselineHashes[$path] = (Get-FileHash -LiteralPath $path).Hash
}
$capture = Join-Path $install 'bin\wonremote-poc.exe'
$fileLock = [IO.File]::Open($capture, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { Invoke-Installer $stagedInstaller 1 }
finally { $fileLock.Dispose() }
Confirm-InstalledVersion $previous
foreach ($path in $baselineHashes.Keys) {
  if ((Get-FileHash -LiteralPath $path).Hash -ne $baselineHashes[$path]) { throw "Failed replacement changed a legacy runtime file: $path" }
}
Confirm-AgentLaunch

Invoke-Installer $stagedInstaller
Confirm-InstalledVersion $version
if ((Get-FileHash -LiteralPath $identity).Hash -ne $identityHash -or
    (Get-FileHash -LiteralPath $uninstaller).Hash -ne $uninstallerHash -or (Test-Path -LiteralPath $config)) {
  throw 'File replacement changed registration state or replaced the existing uninstaller.'
}
Confirm-AgentLaunch
Write-Output "Signed Windows install, failed copy recovery, protected replacement and scheduled launches passed ($previous -> $version). This does not prove startup discovery or authenticated reconnect."
