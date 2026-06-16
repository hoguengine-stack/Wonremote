param(
  [string]$Project = "",
  [switch]$SkipAppBuild,
  [switch]$SparkOnly,
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
    npm run build
  }
  finally {
    Pop-Location
  }
}

if (-not $SparkOnly) {
  Push-Location $FunctionsDir
  try {
    npm run build
  }
  finally {
    Pop-Location
  }
}

$DeployTargets = if ($SparkOnly) {
  if ($SkipStorage) { "firestore:rules,hosting" } else { "firestore:rules,storage,hosting" }
} else {
  if ($SkipStorage) { "functions,firestore:rules,hosting" } else { "functions,firestore:rules,storage,hosting" }
}
if ($SkipStorage) {
  Write-Warning "Skipping Firebase Storage rules deploy. Online 500MB file transfer remains blocked until Firebase Storage is initialized and storage.rules is deployed."
}
$DeployArgs = @("deploy", "--only", $DeployTargets)
if ($Project.Trim()) {
  $DeployArgs += @("--project", $Project.Trim())
}

Push-Location $RepoRoot
try {
  $FirebaseArgs = $FirebasePrefixArgs + $DeployArgs
  & $FirebaseExecutable @FirebaseArgs
}
finally {
  Pop-Location
}
