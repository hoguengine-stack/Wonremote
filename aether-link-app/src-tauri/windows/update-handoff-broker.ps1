$ErrorActionPreference = "Stop"

$taskRoot = Join-Path $PSScriptRoot ".update-handoff"
$pendingPath = Join-Path $taskRoot "pending.json"

if (-not (Test-Path -LiteralPath $pendingPath -PathType Leaf)) {
  exit 2
}

$request = Get-Content -LiteralPath $pendingPath -Raw -Encoding UTF8 | ConvertFrom-Json
$requestId = [string]$request.requestId
if ($requestId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw "The WonRemote update handoff request ID is invalid."
}

$stageRoot = Join-Path $taskRoot $requestId
$scriptPath = Join-Path $stageRoot "handoff.ps1"
$installerPath = Join-Path $stageRoot "installer.exe"
$acceptedPath = Join-Path $stageRoot "installer-started.accepted"

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "The protected WonRemote update handoff files are incomplete."
}

Remove-Item -LiteralPath $pendingPath -Force
$env:WONREMOTE_HANDOFF_INSTALLER_PATH = $installerPath
$env:WONREMOTE_HANDOFF_ACCEPTED_PATH = $acceptedPath

try {
  & "$PSHOME\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $scriptPath
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit $exitCode
} finally {
  Remove-Item Env:\WONREMOTE_HANDOFF_INSTALLER_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\WONREMOTE_HANDOFF_ACCEPTED_PATH -ErrorAction SilentlyContinue
}
