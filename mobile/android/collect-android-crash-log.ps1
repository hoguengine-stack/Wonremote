param([switch]$SelfTest)

$ErrorActionPreference = "Stop"
$AgentPackage = "com.wonremote.agent"
$PlatformToolsUrl = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"

function Get-AdbPath {
  $candidates = @(
    (Join-Path $PSScriptRoot "adb.exe"),
    "C:\Android\sdk\platform-tools\adb.exe"
  )
  if ($env:ANDROID_HOME) { $candidates += Join-Path $env:ANDROID_HOME "platform-tools\adb.exe" }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe" }
  $paths = $candidates | Where-Object { Test-Path $_ }
  if ($paths) { return $paths[0] }
  $command = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $archive = Join-Path $PSScriptRoot "platform-tools.zip"
  $directory = Join-Path $PSScriptRoot "platform-tools"
  Write-Host "ADB was not found. Downloading Android Platform-Tools..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $PlatformToolsUrl -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $PSScriptRoot -Force
  Remove-Item -LiteralPath $archive -Force
  $downloaded = Join-Path $directory "adb.exe"
  if (Test-Path $downloaded) { return $downloaded }
  throw "Android Platform-Tools download did not contain adb.exe."
}

function New-CaptureDirectory {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $directory = Join-Path $PSScriptRoot "WonRemote-Android-Log-$stamp"
  New-Item -ItemType Directory -Path $directory | Out-Null
  return $directory
}

if ($SelfTest) {
  $path = New-CaptureDirectory
  if (-not (Test-Path $path)) { throw "Capture folder creation failed." }
  Remove-Item -LiteralPath $path -Force
  Write-Output "Self-test passed."
  exit 0
}

$adb = Get-AdbPath
$device = (& $adb devices | Select-String "\tdevice$" | Select-Object -First 1).ToString().Split("`t")[0]
if ([string]::IsNullOrWhiteSpace($device)) {
  throw "Connect an Android device and allow USB debugging, then run this again."
}

$output = New-CaptureDirectory
& $adb -s $device logcat -c
Write-Host "Logs cleared. Reproduce the first and second PC Viewer connections, then press Enter."
[void](Read-Host)

& $adb -s $device get-state | Out-File (Join-Path $output "adb-state.txt") -Encoding utf8
& $adb -s $device shell getprop | Out-File (Join-Path $output "device-properties.txt") -Encoding utf8
& $adb -s $device shell dumpsys package $AgentPackage | Out-File (Join-Path $output "agent-package.txt") -Encoding utf8
& $adb -s $device logcat -d -v threadtime | Out-File (Join-Path $output "logcat.txt") -Encoding utf8
& $adb -s $device logcat -d -v threadtime AndroidRuntime:E "WonRemote*:V" "*:S" |
  Out-File (Join-Path $output "wonremote-crash-filtered.txt") -Encoding utf8

$zip = "$output.zip"
Compress-Archive -Path (Join-Path $output "*") -DestinationPath $zip -Force
Write-Host "Complete: $zip"
