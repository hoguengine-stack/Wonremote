$ErrorActionPreference = "Stop"

$AndroidDir = $PSScriptRoot
$RepoRoot = Resolve-Path (Join-Path $AndroidDir "..\..")
$ApkSource = Join-Path $AndroidDir "agent\build\outputs\apk\release\agent-release.apk"
$ApkDestination = Join-Path $RepoRoot "aether-link-app\release-apk\WonRemote-Agent.apk"
$ZipDestination = Join-Path $RepoRoot "aether-link-app\public\download\agent.zip"

if (-not (Test-Path (Join-Path $AndroidDir "keystore.properties"))) {
  throw "mobile/android/keystore.properties is required. Keep the release key outside Git and reuse it for every update."
}

if (-not $env:JAVA_HOME) {
  $KnownJdk = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
  if (Test-Path $KnownJdk) { $env:JAVA_HOME = $KnownJdk }
}
if (-not $env:ANDROID_HOME) {
  $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk"
}
if (-not $env:GRADLE_USER_HOME) {
  $env:GRADLE_USER_HOME = Join-Path $env:LOCALAPPDATA "WonRemoteBuild\gradle-cache"
}

Push-Location $AndroidDir
try {
  & .\gradlew.bat :agent:assembleRelease --build-cache
  if ($LASTEXITCODE -ne 0) { throw "Android Agent release build failed." }
}
finally {
  Pop-Location
}

$ApkSigner = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools\*\apksigner.bat") |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $ApkSigner) { throw "Android SDK apksigner was not found." }

& $ApkSigner verify --verbose $ApkSource
if ($LASTEXITCODE -ne 0) { throw "Android Agent APK signature verification failed." }

New-Item -ItemType Directory -Force (Split-Path -Parent $ApkDestination) | Out-Null
Copy-Item -Force $ApkSource $ApkDestination
$ZipDirectory = Split-Path -Parent $ZipDestination
New-Item -ItemType Directory -Force $ZipDirectory | Out-Null
Compress-Archive -LiteralPath $ApkDestination -DestinationPath $ZipDestination -CompressionLevel Optimal -Force
$Hash = (Get-FileHash -Algorithm SHA256 $ApkDestination).Hash.ToLowerInvariant()
$ZipHash = (Get-FileHash -Algorithm SHA256 $ZipDestination).Hash.ToLowerInvariant()
Write-Output "Android Agent APK ready: $ApkDestination"
Write-Output "SHA-256: $Hash"
Write-Output "Firebase ZIP ready: $ZipDestination"
Write-Output "ZIP SHA-256: $ZipHash"
