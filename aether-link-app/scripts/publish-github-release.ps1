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
$ManifestName = "wonremote-update-manifest.json"
$StableInstallerPath = Join-Path $ReleaseDir $StableInstallerAssetName
$StableAgentInstallerPath = Join-Path $ReleaseDir $StableAgentInstallerAssetName
$ManifestPath = Join-Path $ReleaseDir $ManifestName
$ExpectedAssets = @(
  @{ Name = $StableInstallerAssetName; Path = $StableInstallerPath }
  @{ Name = $StableAgentInstallerAssetName; Path = $StableAgentInstallerPath }
  @{ Name = $ManifestName; Path = $ManifestPath }
)

foreach ($ExpectedAsset in $ExpectedAssets) {
  if (-not (Test-Path -LiteralPath $ExpectedAsset.Path)) {
    throw "Required release asset is missing: $($ExpectedAsset.Path)"
  }
}

& npm run test:update-e2e
if ($LASTEXITCODE -ne 0) {
  throw "Installer update E2E preflight failed with exit code $LASTEXITCODE."
}

& node (Join-Path $ScriptDir "verify-x86-installer-payloads.js")
if ($LASTEXITCODE -ne 0) {
  throw "x86 installer payload preflight failed with exit code $LASTEXITCODE."
}

& node (Join-Path $ScriptDir "verify-release-manifest.js") `
  --manifest $ManifestPath `
  --version $Version `
  --viewer-x64 $StableInstallerPath `
  --agent-x64 $StableAgentInstallerPath `
  --viewer-asset-name-x64 $StableInstallerAssetName `
  --agent-asset-name-x64 $StableAgentInstallerAssetName
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
} catch {
  if ((Get-StatusCode $_) -ne 404) {
    throw
  }
  $ReleaseList = Invoke-GitHubJson "Get" "${ReleaseApi}?per_page=100"
  $Release = $ReleaseList | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
}
if ($Release) {
  Write-Host "Found existing GitHub Release $Tag."
  if (-not $Release.draft) {
    throw "Refusing to replace published release $Tag. Bump the version before publishing so installed clients can detect the update."
  }
} else {
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
  return Invoke-RestMethod -Method Post -Uri $UploadUrl -Headers $Headers -InFile $FilePath -ContentType $ContentType
}

$PublishedAssets = @(
  Publish-Asset $StableInstallerPath $StableInstallerAssetName "application/octet-stream"
  Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName "application/octet-stream"
  Publish-Asset $ManifestPath $ManifestName "application/json"
)

# Keep a partial or wrong upload private. Each successful upload returns its stored asset metadata.
if ($PublishedAssets.Count -ne $ExpectedAssets.Count) {
  throw "Release upload verification failed: expected $($ExpectedAssets.Count) assets, found $($PublishedAssets.Count)."
}
foreach ($ExpectedAsset in $ExpectedAssets) {
  $MatchingAssets = @($PublishedAssets | Where-Object { $_.name -eq $ExpectedAsset.Name })
  if ($MatchingAssets.Count -ne 1) {
    throw "Release upload verification failed: expected exactly one $($ExpectedAsset.Name)."
  }
  $LocalSize = (Get-Item -LiteralPath $ExpectedAsset.Path).Length
  if ([int64]$MatchingAssets[0].size -ne [int64]$LocalSize) {
    throw "Release upload verification failed: $($ExpectedAsset.Name) size differs from the local signed asset."
  }
}

# Verify the bytes GitHub stored, rather than trusting a successful upload response.
$RemoteVerificationDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("wonremote-release-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $RemoteVerificationDirectory -Force | Out-Null
try {
  $DownloadHeaders = @{}
  foreach ($HeaderName in $Headers.Keys) {
    $DownloadHeaders[$HeaderName] = $Headers[$HeaderName]
  }
  $DownloadHeaders["Accept"] = "application/octet-stream"
  $RemoteAssetPaths = @{}
  foreach ($ExpectedAsset in $ExpectedAssets) {
    $RemoteAsset = @($PublishedAssets | Where-Object { $_.name -eq $ExpectedAsset.Name })[0]
    $RemotePath = Join-Path $RemoteVerificationDirectory $ExpectedAsset.Name
    Invoke-WebRequest -Uri $RemoteAsset.url -Headers $DownloadHeaders -OutFile $RemotePath
    if ((Get-Item -LiteralPath $RemotePath).Length -ne (Get-Item -LiteralPath $ExpectedAsset.Path).Length) {
      throw "Release download verification failed: $($ExpectedAsset.Name) bytes differ from the uploaded asset."
    }
    $RemoteAssetPaths[$ExpectedAsset.Name] = $RemotePath
  }
  & node (Join-Path $ScriptDir "verify-release-manifest.js") `
    --manifest $RemoteAssetPaths[$ManifestName] `
    --version $Version `
    --viewer-x64 $RemoteAssetPaths[$StableInstallerAssetName] `
    --agent-x64 $RemoteAssetPaths[$StableAgentInstallerAssetName] `
    --viewer-asset-name-x64 $StableInstallerAssetName `
    --agent-asset-name-x64 $StableAgentInstallerAssetName
  if ($LASTEXITCODE -ne 0) {
    throw "Release download verification failed with exit code $LASTEXITCODE."
  }
} finally {
  Remove-Item -LiteralPath $RemoteVerificationDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $RequestedDraft) {
  Write-Host "Publishing GitHub Release $Tag after every required asset was uploaded."
  $Release = Invoke-GitHubJson "Patch" "$ReleaseApi/$($Release.id)" @{
    name = "WonRemote $Version"
    draft = $false
    prerelease = $RequestedPrerelease
  }
}

Write-Host "Published WonRemote release assets for $Tag."
