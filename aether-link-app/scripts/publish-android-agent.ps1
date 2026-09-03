param(
  [string]$Repository = "hoguengine-stack/Wonremote",
  [string]$Tag = "android-agent-latest"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Split-Path -Parent $ScriptDir
$Package = Get-Content -Raw (Join-Path $AppRoot "package.json") | ConvertFrom-Json
$AssetName = "WonRemote-Agent.apk"
$AssetPath = Join-Path $AppRoot "release-apk\$AssetName"
$Token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }

if (-not $Token) { throw "GITHUB_TOKEN or GH_TOKEN is required." }
if (-not (Test-Path $AssetPath)) { throw "Android Agent APK is missing: $AssetPath" }

$Headers = @{
  Accept = "application/vnd.github+json"
  Authorization = "Bearer $Token"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "WonRemote-Android-Publisher"
}
$ReleaseApi = "https://api.github.com/repos/$Repository/releases"

try {
  $Release = Invoke-RestMethod -Uri "$ReleaseApi/tags/$Tag" -Headers $Headers
} catch {
  if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
  $Release = Invoke-RestMethod -Method Post -Uri $ReleaseApi -Headers $Headers -ContentType "application/json" -Body (@{
    tag_name = $Tag
    target_commitish = "main"
    name = "WonRemote Android Agent"
    body = "Stable Android Agent download. Current APK version: $($Package.version)"
    draft = $false
    prerelease = $false
  } | ConvertTo-Json)
}

$Assets = Invoke-RestMethod -Uri "$ReleaseApi/$($Release.id)/assets" -Headers $Headers
$Existing = $Assets | Where-Object name -eq $AssetName | Select-Object -First 1
if ($Existing) {
  Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Repository/releases/assets/$($Existing.id)" -Headers $Headers | Out-Null
}

$UploadName = [uri]::EscapeDataString($AssetName)
$Uploaded = Invoke-RestMethod -Method Post `
  -Uri "https://uploads.github.com/repos/$Repository/releases/$($Release.id)/assets?name=$UploadName" `
  -Headers $Headers `
  -InFile $AssetPath `
  -ContentType "application/vnd.android.package-archive"

$LocalFile = Get-Item $AssetPath
if ([int64]$Uploaded.size -ne [int64]$LocalFile.Length) { throw "Uploaded APK size verification failed." }

$TempFile = Join-Path ([IO.Path]::GetTempPath()) ("wonremote-agent-" + [guid]::NewGuid().ToString("N") + ".apk")
try {
  $DownloadHeaders = $Headers.Clone()
  $DownloadHeaders.Accept = "application/octet-stream"
  Invoke-WebRequest -Uri $Uploaded.url -Headers $DownloadHeaders -OutFile $TempFile
  $LocalHash = (Get-FileHash -Algorithm SHA256 $AssetPath).Hash
  $RemoteHash = (Get-FileHash -Algorithm SHA256 $TempFile).Hash
  if ($LocalHash -ne $RemoteHash) { throw "Uploaded APK hash verification failed." }
} finally {
  Remove-Item -LiteralPath $TempFile -Force -ErrorAction SilentlyContinue
}

Write-Output "Published $AssetName version $($Package.version) to release $Tag."
