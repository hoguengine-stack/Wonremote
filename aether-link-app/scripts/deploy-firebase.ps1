param(
  [string]$Project = "",
  [switch]$SkipAppBuild,
  [switch]$SparkOnly,
  [switch]$IncludeStorage,
  [switch]$SkipStorage
)

$ErrorActionPreference = "Stop"

$DeployApproved = $env:WONREMOTE_FIREBASE_DEPLOY_APPROVED
if ($DeployApproved -ne "YES") {
  throw "WonRemote Firebase deploy gate is locked. Set WONREMOTE_FIREBASE_DEPLOY_APPROVED=YES to deploy functions, rules, and hosting."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot = Resolve-Path (Join-Path $AppDir "..")
$FunctionsDir = Join-Path $RepoRoot "functions"

if (-not (Test-Path (Join-Path $RepoRoot "firebase.json"))) {
  throw "firebase.json was not found at repository root."
}
if (-not (Test-Path (Join-Path $RepoRoot ".firebaserc"))) {
  throw ".firebaserc was not found at repository root."
}
if (-not (Test-Path (Join-Path $FunctionsDir "package.json"))) {
  throw "functions/package.json was not found."
}

$FirebaseCommand = Get-Command firebase -ErrorAction SilentlyContinue
$FirebaseExecutable = $null
$FirebasePrefixArgs = @()
if ($FirebaseCommand) {
  $FirebaseExecutable = $FirebaseCommand.Source
} else {
  $NpxCommand = Get-Command npx -ErrorAction SilentlyContinue
  if (-not $NpxCommand) {
    throw "Firebase CLI was not found. Install firebase-tools, npm/npx, or make firebase available on PATH."
  }
  $FirebaseExecutable = $NpxCommand.Source
  $FirebasePrefixArgs = @("firebase-tools")
}

if (-not $SkipAppBuild) {
  Push-Location $AppDir
  try {
    npm run change:verify:predeploy
    if ($LASTEXITCODE -ne 0) { throw "Development predeploy gate failed." }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "WonRemote app build failed." }
  }
  finally {
    Pop-Location
  }
}

if (-not $SparkOnly) {
  Push-Location $FunctionsDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Firebase Functions build failed." }
  }
  finally {
    Pop-Location
  }
}

$DeployStorage = $IncludeStorage -and -not $SkipStorage
$DeployTargets = if ($SparkOnly) {
  if ($DeployStorage) { "firestore:rules,storage,hosting" } else { "firestore:rules,hosting" }
} else {
  if ($DeployStorage) { "functions,firestore:rules,storage,hosting" } else { "functions,firestore:rules,hosting" }
}
if (-not $DeployStorage) {
  Write-Warning "Skipping Firebase Storage rules deploy. Initialize Firebase Storage, then rerun with -IncludeStorage before enabling online 500MB file transfer."
}
$DeployArgs = @("deploy", "--only", $DeployTargets)
if ($Project.Trim()) {
  $DeployArgs += @("--project", $Project.Trim())
}

Push-Location $RepoRoot
try {
  $FirebaseArgs = $FirebasePrefixArgs + $DeployArgs
  & $FirebaseExecutable @FirebaseArgs
  if ($LASTEXITCODE -ne 0) { throw "Firebase deployment failed with exit code $LASTEXITCODE." }
}
finally {
  Pop-Location
}
