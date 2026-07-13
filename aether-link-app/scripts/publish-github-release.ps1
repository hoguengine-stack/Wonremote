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

$ReleaseGateApproved = $env:WONREMOTE_RELEASE_GATE_APPROVED
if ($ReleaseGateApproved -ne "YES") {
  throw @"
WonRemote release gate is locked.
Set WONREMOTE_RELEASE_GATE_APPROVED=YES only after confirming all P0/P1 requirements are complete except explicitly deferred physical J1800/J1900 validation.
Do not use this flag for routine E2E update testing; use a local fixture/update server instead.
"@
}

$Token = $env:GITHUB_TOKEN
if (-not $Token) {
  $Token = $env:GH_TOKEN
}
if (-not $Token) {
  throw "GITHUB_TOKEN or GH_TOKEN is required to publish GitHub Release assets."
}

$Tag = "v$Version"
$RequestedDraft = [bool]$Draft
$RequestedPrerelease = [bool]$Prerelease
$ReleaseDir = Join-Path $AppRoot "release-exe"
$StableInstallerAssetName = "WonRemote-Viewer-Setup.exe"
$StableAgentInstallerAssetName = "WonRemote-Agent-Setup.exe"
$StableInstallerAssetNameX86 = "WonRemote-Viewer-Setup-x86.exe"
$StableAgentInstallerAssetNameX86 = "WonRemote-Agent-Setup-x86.exe"
$ManifestName = "wonremote-update-manifest.json"
$StableInstallerPath = Join-Path $ReleaseDir $StableInstallerAssetName
$StableAgentInstallerPath = Join-Path $ReleaseDir $StableAgentInstallerAssetName
$StableInstallerPathX86 = Join-Path $ReleaseDir $StableInstallerAssetNameX86
$StableAgentInstallerPathX86 = Join-Path $ReleaseDir $StableAgentInstallerAssetNameX86
$ManifestPath = Join-Path $ReleaseDir $ManifestName

foreach ($RequiredPath in @($StableInstallerPath, $StableAgentInstallerPath, $StableInstallerPathX86, $StableAgentInstallerPathX86, $ManifestPath)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) {
    throw "Required release asset is missing: $RequiredPath"
  }
}

& node (Join-Path $ScriptDir "verify-release-manifest.js") `
  --manifest $ManifestPath `
  --version $Version `
  --viewer-x64 $StableInstallerPath `
  --viewer-x86 $StableInstallerPathX86 `
  --agent-x64 $StableAgentInstallerPath `
  --agent-x86 $StableAgentInstallerPathX86 `
  --viewer-asset-name-x64 $StableInstallerAssetName `
  --viewer-asset-name-x86 $StableInstallerAssetNameX86 `
  --agent-asset-name-x64 $StableAgentInstallerAssetName `
  --agent-asset-name-x86 $StableAgentInstallerAssetNameX86
if ($LASTEXITCODE -ne 0) {
  throw "Release manifest preflight failed with exit code $LASTEXITCODE."
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
  if (-not $Release.draft) {
    Write-Host "Temporarily moving $Tag back to draft so stable download links never expose a partial asset set."
    $Release = Invoke-GitHubJson "Patch" "$ReleaseApi/$($Release.id)" @{
      draft = $true
    }
  }
} catch {
  if ((Get-StatusCode $_) -ne 404) {
    throw
  }
  Write-Host "Creating GitHub Release $Tag."
  $Release = Invoke-GitHubJson "Post" $ReleaseApi @{
    tag_name = $Tag
    target_commitish = "main"
    name = "WonRemote $Version"
    draft = $true
    prerelease = $RequestedPrerelease
  }
}

$AssetsApi = "$ReleaseApi/$($Release.id)/assets"
$ExistingAssets = Invoke-GitHubJson "Get" $AssetsApi
foreach ($Asset in $ExistingAssets) {
  Write-Host "Deleting existing asset $($Asset.name)."
  Invoke-GitHubJson "Delete" "https://api.github.com/repos/$Repository/releases/assets/$($Asset.id)" | Out-Null
}

function Publish-Asset($FilePath, $AssetName, $ContentType) {
  $EscapedName = [uri]::EscapeDataString($AssetName)
  $UploadUrl = "https://uploads.github.com/repos/$Repository/releases/$($Release.id)/assets?name=$EscapedName"
  Write-Host "Uploading $AssetName."
  Invoke-RestMethod -Method Post -Uri $UploadUrl -Headers $Headers -InFile $FilePath -ContentType $ContentType | Out-Null
}

Publish-Asset $StableInstallerPath $StableInstallerAssetName "application/octet-stream"
Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName "application/octet-stream"
Publish-Asset $StableInstallerPathX86 $StableInstallerAssetNameX86 "application/octet-stream"
Publish-Asset $StableAgentInstallerPathX86 $StableAgentInstallerAssetNameX86 "application/octet-stream"
Publish-Asset $ManifestPath $ManifestName "application/json"

if (-not $RequestedDraft) {
  Write-Host "Publishing GitHub Release $Tag after every required asset was uploaded."
  $Release = Invoke-GitHubJson "Patch" "$ReleaseApi/$($Release.id)" @{
    name = "WonRemote $Version"
    draft = $false
    prerelease = $RequestedPrerelease
  }
}

Write-Host "Published WonRemote release assets for $Tag."
