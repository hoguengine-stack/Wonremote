$ErrorActionPreference = "Stop"

$releaseDir = Join-Path $PSScriptRoot "..\release-exe"
$installers = @(
  Join-Path $releaseDir "WonRemote-Viewer-Setup.exe"
  Join-Path $releaseDir "WonRemote-Agent-Setup.exe"
)
$missing = @($installers | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missing.Count -gt 0) {
  throw "Authenticode signing input is missing: $($missing -join ', ')"
}

$requireSigning = $env:WONREMOTE_REQUIRE_AUTHENTICODE -match '^(1|true|yes|on)$'
$pfxBase64 = $env:WONREMOTE_AUTHENTICODE_PFX_BASE64
$pfxPassword = $env:WONREMOTE_AUTHENTICODE_PFX_PASSWORD
if ([string]::IsNullOrWhiteSpace($pfxBase64) -or [string]::IsNullOrWhiteSpace($pfxPassword)) {
  if ($requireSigning) {
    throw "Authenticode signing is required but WONREMOTE_AUTHENTICODE_PFX_BASE64/PASSWORD is missing."
  }
  Write-Host "Authenticode certificate is not configured; release installers remain unsigned."
  exit 0
}

$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  [IO.Path]::GetTempPath()
} else {
  $env:RUNNER_TEMP
}
$pfxPath = Join-Path $temporaryRoot "wonremote-authenticode.pfx"
try {
  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($pfxBase64))
  $certificate = Get-PfxCertificate -FilePath $pfxPath -Password (ConvertTo-SecureString $pfxPassword -AsPlainText -Force)
  foreach ($installer in $installers) {
    $signature = Set-AuthenticodeSignature `
      -FilePath $installer `
      -Certificate $certificate `
      -HashAlgorithm SHA256 `
      -TimestampServer "http://timestamp.digicert.com"
    if ($signature.Status -ne "Valid") {
      throw "Authenticode signing failed for $installer ($($signature.Status): $($signature.StatusMessage))"
    }
    Write-Host "Authenticode signature verified: $([IO.Path]::GetFileName($installer))"
  }
}
finally {
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
}
