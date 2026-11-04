param(
  [string]$Project = "",
  [switch]$SkipAppBuild,
  [switch]$SparkOnly,
  [switch]$IncludeFunctions,
  [switch]$IncludeStorage,
  [switch]$SkipStorage,
  [switch]$HostingOnly,
  [switch]$ViewerOnly
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

$ManifestPath = Join-Path $AppDir 'public/updates/viewer-latest.json'
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw 'Stage the fresh CI-signed Viewer discovery before Hosting deployment.' }
$Version = (Get-Content -LiteralPath (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
$VerifierArgs = @('--manifest',$ManifestPath,'--version',$Version,'--viewer-x64',(Join-Path $AppDir 'release-exe/WonRemote-Viewer-Setup.exe'))
if ($ViewerOnly) { $VerifierArgs += @('--viewer-only','true') }
else { $VerifierArgs += @('--agent-x64',(Join-Path $AppDir 'release-exe/WonRemote-Agent-Setup.exe')) }
& node (Join-Path $ScriptDir 'verify-release-manifest.js') @VerifierArgs
if ($LASTEXITCODE -ne 0) { throw 'Staged Viewer discovery failed original-key signature/version/payload verification.' }

$AndroidScope = @(if ($ViewerOnly) { '--viewer-only' })
& node (Join-Path $RepoRoot "mobile/android/create-update-manifest.mjs") --verify @AndroidScope
if ($LASTEXITCODE -ne 0) {
  throw "Android update metadata is missing or stale. Rebuild the three Android apps before deploying their downloads."
}

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

& node (Join-Path $RepoRoot "mobile/android/create-update-manifest.mjs") --verify-hosted @AndroidScope
if ($LASTEXITCODE -ne 0) { throw "Android Hosting output does not match verified release artifacts." }

& node (Join-Path $RepoRoot "mobile/android/create-update-manifest.mjs") --verify-live-history
if ($LASTEXITCODE -ne 0) { throw "Published Android archive preservation failed; do not deploy Hosting." }

if ((Get-FileHash -LiteralPath $ManifestPath).Hash -cne (Get-FileHash -LiteralPath (Join-Path $AppDir 'dist/updates/viewer-latest.json')).Hash) {
  throw 'Hosting contains stale Viewer discovery; rebuild frontend with signed metadata staged.'
}
$DeployFunctions = $IncludeFunctions -and -not $SparkOnly -and -not ($HostingOnly -or $ViewerOnly)
$DeployStorage = $IncludeStorage -and -not $SkipStorage -and -not ($HostingOnly -or $ViewerOnly)

if ($DeployFunctions) {
  Push-Location $FunctionsDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Firebase Functions build failed." }
  }
  finally {
    Pop-Location
  }
}

$DeployTargets = if ($HostingOnly -or $ViewerOnly) { 'hosting' } elseif ($SparkOnly) {
  if ($DeployStorage) { "firestore:rules,storage,hosting" } else { "firestore:rules,hosting" }
} else {
  if ($DeployFunctions -and $DeployStorage) { "functions,firestore:rules,storage,hosting" }
  elseif ($DeployFunctions) { "functions,firestore:rules,hosting" }
  elseif ($DeployStorage) { "firestore:rules,storage,hosting" }
  else { "firestore:rules,hosting" }
}
if (-not $DeployFunctions) {
  Write-Warning "Skipping Firebase Functions deploy. Use -IncludeFunctions only after the project can enable Cloud Build and Artifact Registry."
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
  $Config = Get-Content -LiteralPath (Join-Path $RepoRoot 'firebase.json') -Raw | ConvertFrom-Json
  foreach ($Alias in @('viewer','viewer-x86','agent','agent-x86')) {
    $Expected = @($Config.hosting.redirects | Where-Object { $_.source -eq "/download/$Alias" })[0].destination
    if (-not $Expected) { throw "Missing explicit download alias $Alias" }
    $Headers = & curl.exe --silent --show-error --head --max-redirs 0 "https://wonremote-a7fd3.web.app/download/$Alias"
    if ($LASTEXITCODE -ne 0) { throw "Alias check failed: $Alias" }
    $Status = @($Headers | Where-Object { $_ -match '^HTTP/' })[-1]
    $Location = (@($Headers | Where-Object { $_ -match '^location:' })[0] -replace '^location:\s*','').Trim()
    if ($Status -notmatch '\s302\s' -or $Location -ne $Expected) { throw "Published alias mismatch: $Alias" }
  }
  $ManifestPath = Join-Path $AppDir 'public/updates/viewer-latest.json'
  if (-not (Test-Path -LiteralPath $ManifestPath)) { throw 'Viewer discovery was not staged.' }
  $Live = Invoke-WebRequest -Uri 'https://wonremote-a7fd3.web.app/updates/viewer-latest.json' -UseBasicParsing
  $Local = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if (($Live.Content | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress) -cne ($Local | ConvertTo-Json -Depth 20 -Compress)) { throw 'Published Viewer discovery differs from signed release.' }
}
finally {
  Pop-Location
}
