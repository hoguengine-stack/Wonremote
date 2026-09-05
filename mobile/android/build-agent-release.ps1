$ErrorActionPreference = "Stop"

$AndroidDir = $PSScriptRoot
$RepoRoot = Resolve-Path (Join-Path $AndroidDir "..\..")
$Products = @(
  @{
    Name = "Agent"
    Source = Join-Path $AndroidDir "agent\build\outputs\apk\release\agent-release.apk"
    Apk = Join-Path $RepoRoot "aether-link-app\release-apk\WonRemote-Agent.apk"
    Zip = Join-Path $RepoRoot "aether-link-app\public\download\agent.zip"
  },
  @{
    Name = "Viewer"
    Source = Join-Path $AndroidDir "viewer\build\outputs\apk\release\viewer-release.apk"
    Apk = Join-Path $RepoRoot "aether-link-app\release-apk\WonRemote-Viewer.apk"
    Zip = Join-Path $RepoRoot "aether-link-app\public\download\viewer.zip"
  },
  @{
    Name = "Control Add-On"
    Source = Join-Path $AndroidDir "controladdon\build\outputs\apk\release\controladdon-release.apk"
    Apk = Join-Path $RepoRoot "aether-link-app\release-apk\WonRemote-Control-Addon.apk"
    Zip = Join-Path $RepoRoot "aether-link-app\public\download\control-addon.zip"
  }
)

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
  & .\gradlew.bat :agent:assembleRelease :viewer:assembleRelease :controladdon:assembleRelease --build-cache --parallel
  if ($LASTEXITCODE -ne 0) { throw "Android Agent/Viewer/Control Add-On release build failed." }
}
finally {
  Pop-Location
}

$ApkSigner = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools\*\apksigner.bat") |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $ApkSigner) { throw "Android SDK apksigner was not found." }

foreach ($Product in $Products) {
  & $ApkSigner verify --verbose $Product.Source
  if ($LASTEXITCODE -ne 0) { throw "Android $($Product.Name) APK signature verification failed." }

  New-Item -ItemType Directory -Force (Split-Path -Parent $Product.Apk) | Out-Null
  Copy-Item -Force $Product.Source $Product.Apk
  New-Item -ItemType Directory -Force (Split-Path -Parent $Product.Zip) | Out-Null
  Compress-Archive -LiteralPath $Product.Apk -DestinationPath $Product.Zip -CompressionLevel Optimal -Force

  $ApkHash = (Get-FileHash -Algorithm SHA256 $Product.Apk).Hash.ToLowerInvariant()
  $ZipHash = (Get-FileHash -Algorithm SHA256 $Product.Zip).Hash.ToLowerInvariant()
  Write-Output "Android $($Product.Name) APK ready: $($Product.Apk)"
  Write-Output "APK SHA-256: $ApkHash"
  Write-Output "Firebase ZIP ready: $($Product.Zip)"
  Write-Output "ZIP SHA-256: $ZipHash"
}
