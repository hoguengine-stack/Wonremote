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
$InstallerName = "WonRemote Viewer_${Version}_x64-setup.exe"
$InstallerAssetName = $InstallerName -replace "\s+", "."
$AgentInstallerName = "WonRemote Agent_${Version}_x64-setup.exe"
$AgentInstallerAssetName = $AgentInstallerName -replace "\s+", "."
$InstallerNameX86 = "WonRemote Viewer_${Version}_x86-setup.exe"
$InstallerAssetNameX86 = $InstallerNameX86 -replace "\s+", "."
$AgentInstallerNameX86 = "WonRemote Agent_${Version}_x86-setup.exe"
$AgentInstallerAssetNameX86 = $AgentInstallerNameX86 -replace "\s+", "."
$StableInstallerAssetName = "WonRemote-Viewer-Setup.exe"
$StableAgentInstallerAssetName = "WonRemote-Agent-Setup.exe"
$StableFullInstallerAssetName = "WonRemote-Viewer-Agent-Setup.exe"
$PortableZipName = "WonRemote-Viewer-Agent-Portable.zip"
$AgentZipName = "WonRemote-Agent-Portable.zip"
$StableInstallerAssetNameX86 = "WonRemote-Viewer-Setup-x86.exe"
$StableAgentInstallerAssetNameX86 = "WonRemote-Agent-Setup-x86.exe"
$StableFullInstallerAssetNameX86 = "WonRemote-Viewer-Agent-Setup-x86.exe"
$PortableZipNameX86 = "WonRemote-Viewer-Agent-Portable-x86.zip"
$AgentZipNameX86 = "WonRemote-Agent-Portable-x86.zip"
$ManifestName = "wonremote-update-manifest.json"
$InstallerPath = Join-Path $ReleaseDir $InstallerName
$AgentInstallerPath = Join-Path $ReleaseDir $AgentInstallerName
$InstallerPathX86 = Join-Path $ReleaseDir $InstallerNameX86
$AgentInstallerPathX86 = Join-Path $ReleaseDir $AgentInstallerNameX86
$StableInstallerPath = Join-Path $ReleaseDir $StableInstallerAssetName
$StableAgentInstallerPath = Join-Path $ReleaseDir $StableAgentInstallerAssetName
$StableFullInstallerPath = Join-Path $ReleaseDir $StableFullInstallerAssetName
$PortableZipPath = Join-Path $ReleaseDir $PortableZipName
$AgentZipPath = Join-Path $ReleaseDir $AgentZipName
$StableInstallerPathX86 = Join-Path $ReleaseDir $StableInstallerAssetNameX86
$StableAgentInstallerPathX86 = Join-Path $ReleaseDir $StableAgentInstallerAssetNameX86
$StableFullInstallerPathX86 = Join-Path $ReleaseDir $StableFullInstallerAssetNameX86
$PortableZipPathX86 = Join-Path $ReleaseDir $PortableZipNameX86
$AgentZipPathX86 = Join-Path $ReleaseDir $AgentZipNameX86
$ManifestPath = Join-Path $ReleaseDir $ManifestName

foreach ($RequiredPath in @($InstallerPath, $AgentInstallerPath, $InstallerPathX86, $AgentInstallerPathX86, $StableInstallerPath, $StableAgentInstallerPath, $StableFullInstallerPath, $PortableZipPath, $AgentZipPath, $StableInstallerPathX86, $StableAgentInstallerPathX86, $StableFullInstallerPathX86, $PortableZipPathX86, $AgentZipPathX86, $ManifestPath)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) {
    throw "Required release asset is missing: $RequiredPath"
  }
}

& node (Join-Path $ScriptDir "verify-release-manifest.js") `
  --manifest $ManifestPath `
  --version $Version `
  --installer-x64 $StableFullInstallerPath `
  --installer-x86 $StableFullInstallerPathX86 `
  --portable-x64 $PortableZipPath `
  --portable-x86 $PortableZipPathX86 `
  --portable-agent-x64 $AgentZipPath `
  --portable-agent-x86 $AgentZipPathX86 `
  --asset-name-x64 $StableFullInstallerAssetName `
  --asset-name-x86 $StableFullInstallerAssetNameX86 `
  --portable-asset-name-x64 $PortableZipName `
  --portable-asset-name-x86 $PortableZipNameX86 `
  --portable-agent-asset-name-x64 $AgentZipName `
  --portable-agent-asset-name-x86 $AgentZipNameX86
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
  if ($Asset.name -eq $InstallerName -or $Asset.name -eq $InstallerAssetName -or $Asset.name -eq $AgentInstallerName -or $Asset.name -eq $AgentInstallerAssetName -or $Asset.name -eq $InstallerNameX86 -or $Asset.name -eq $InstallerAssetNameX86 -or $Asset.name -eq $AgentInstallerNameX86 -or $Asset.name -eq $AgentInstallerAssetNameX86 -or $Asset.name -eq $StableInstallerAssetName -or $Asset.name -eq $StableAgentInstallerAssetName -or $Asset.name -eq $StableFullInstallerAssetName -or $Asset.name -eq $PortableZipName -or $Asset.name -eq $AgentZipName -or $Asset.name -eq $StableInstallerAssetNameX86 -or $Asset.name -eq $StableAgentInstallerAssetNameX86 -or $Asset.name -eq $StableFullInstallerAssetNameX86 -or $Asset.name -eq $PortableZipNameX86 -or $Asset.name -eq $AgentZipNameX86 -or $Asset.name -eq $ManifestName) {
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
Publish-Asset $AgentInstallerPath $AgentInstallerAssetName "application/octet-stream"
Publish-Asset $InstallerPathX86 $InstallerAssetNameX86 "application/octet-stream"
Publish-Asset $AgentInstallerPathX86 $AgentInstallerAssetNameX86 "application/octet-stream"
Publish-Asset $StableInstallerPath $StableInstallerAssetName "application/octet-stream"
Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName "application/octet-stream"
Publish-Asset $StableFullInstallerPath $StableFullInstallerAssetName "application/octet-stream"
Publish-Asset $PortableZipPath $PortableZipName "application/zip"
Publish-Asset $AgentZipPath $AgentZipName "application/zip"
Publish-Asset $StableInstallerPathX86 $StableInstallerAssetNameX86 "application/octet-stream"
Publish-Asset $StableAgentInstallerPathX86 $StableAgentInstallerAssetNameX86 "application/octet-stream"
Publish-Asset $StableFullInstallerPathX86 $StableFullInstallerAssetNameX86 "application/octet-stream"
Publish-Asset $PortableZipPathX86 $PortableZipNameX86 "application/zip"
Publish-Asset $AgentZipPathX86 $AgentZipNameX86 "application/zip"
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
