param(
  [string]$Repository = "hoguengine-stack/Wonremote",
  [string]$Version = "",
  [switch]$Draft,
  [switch]$Prerelease
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Split-Path -Parent $ScriptDir
$PackageJson = Get-Content -Raw -LiteralPath (Join-Path $AppRoot "package.json") | ConvertFrom-Json

if (-not $Version) {
  $Version = $PackageJson.version
}

$Token = $env:GITHUB_TOKEN
if (-not $Token) {
  $Token = $env:GH_TOKEN
}
if (-not $Token) {
  throw "GITHUB_TOKEN or GH_TOKEN is required to publish GitHub Release assets."
}

$Tag = "v$Version"
$ReleaseDir = Join-Path $AppRoot "release-exe"
$InstallerName = "WonRemote Viewer_${Version}_x64-setup.exe"
$InstallerAssetName = $InstallerName -replace "\s+", "."
$StableInstallerAssetName = "WonRemote-Viewer-Setup.exe"
$StableAgentInstallerAssetName = "WonRemote-Agent-Setup.exe"
$StableFullInstallerAssetName = "WonRemote-Viewer-Agent-Setup.exe"
$PortableZipName = "WonRemote-Viewer-Agent-Portable.zip"
$AgentZipName = "WonRemote-Agent-Portable.zip"
$ManifestName = "wonremote-update-manifest.json"
$InstallerPath = Join-Path $ReleaseDir $InstallerName
$PortableZipPath = Join-Path $ReleaseDir $PortableZipName
$AgentZipPath = Join-Path $ReleaseDir $AgentZipName
$ManifestPath = Join-Path $ReleaseDir $ManifestName

foreach ($RequiredPath in @($InstallerPath, $PortableZipPath, $AgentZipPath, $ManifestPath)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) {
    throw "Required release asset is missing: $RequiredPath"
  }
}

$Headers = @{
  "Accept" = "application/vnd.github+json"
  "Authorization" = "Bearer $Token"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "WonRemote-Release-Publisher"
}

function Get-StatusCode($ErrorRecord) {
  if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.StatusCode) {
    return [int]$ErrorRecord.Exception.Response.StatusCode
  }
  return 0
}

function Invoke-GitHubJson($Method, $Uri, $Body = $null) {
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
  }
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body ($Body | ConvertTo-Json -Depth 10) -ContentType "application/json"
}

$ReleaseApi = "https://api.github.com/repos/$Repository/releases"
$Release = $null
try {
  $Release = Invoke-GitHubJson "Get" "$ReleaseApi/tags/$Tag"
  Write-Host "Found existing GitHub Release $Tag."
} catch {
  if ((Get-StatusCode $_) -ne 404) {
    throw
  }
  Write-Host "Creating GitHub Release $Tag."
  $Release = Invoke-GitHubJson "Post" $ReleaseApi @{
    tag_name = $Tag
    target_commitish = "main"
    name = "WonRemote $Version"
    draft = [bool]$Draft
    prerelease = [bool]$Prerelease
  }
}

$AssetsApi = "$ReleaseApi/$($Release.id)/assets"
$ExistingAssets = Invoke-GitHubJson "Get" $AssetsApi
foreach ($Asset in $ExistingAssets) {
  if ($Asset.name -eq $InstallerName -or $Asset.name -eq $InstallerAssetName -or $Asset.name -eq $StableInstallerAssetName -or $Asset.name -eq $StableAgentInstallerAssetName -or $Asset.name -eq $StableFullInstallerAssetName -or $Asset.name -eq $PortableZipName -or $Asset.name -eq $AgentZipName -or $Asset.name -eq $ManifestName) {
    Write-Host "Deleting existing asset $($Asset.name)."
    Invoke-GitHubJson "Delete" "https://api.github.com/repos/$Repository/releases/assets/$($Asset.id)" | Out-Null
  }
}

function Publish-Asset($FilePath, $AssetName, $ContentType) {
  $EscapedName = [uri]::EscapeDataString($AssetName)
  $UploadUrl = "https://uploads.github.com/repos/$Repository/releases/$($Release.id)/assets?name=$EscapedName"
  Write-Host "Uploading $AssetName."
  Invoke-RestMethod -Method Post -Uri $UploadUrl -Headers $Headers -InFile $FilePath -ContentType $ContentType | Out-Null
}

Publish-Asset $InstallerPath $InstallerAssetName "application/octet-stream"
Publish-Asset $InstallerPath $StableInstallerAssetName "application/octet-stream"
Publish-Asset $InstallerPath $StableAgentInstallerAssetName "application/octet-stream"
Publish-Asset $InstallerPath $StableFullInstallerAssetName "application/octet-stream"
Publish-Asset $PortableZipPath $PortableZipName "application/zip"
Publish-Asset $AgentZipPath $AgentZipName "application/zip"
Publish-Asset $ManifestPath $ManifestName "application/json"

Write-Host "Published WonRemote release assets for $Tag."
