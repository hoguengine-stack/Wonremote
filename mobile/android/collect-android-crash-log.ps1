param([switch]$SelfTest)

$ErrorActionPreference = "Stop"
$AgentPackage = "com.wonremote.agent"

function Get-AdbPath {
  $candidates = @((Join-Path $PSScriptRoot "adb.exe"))
  if ($env:ANDROID_HOME) { $candidates += Join-Path $env:ANDROID_HOME "platform-tools\adb.exe" }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe" }
  $paths = $candidates | Where-Object { Test-Path $_ }
  if ($paths) { return $paths[0] }
  $command = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "ADB를 찾지 못했습니다. Android SDK Platform-Tools를 설치하거나 adb.exe를 이 파일 옆에 두세요."
}

function New-CaptureDirectory {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $directory = Join-Path $PSScriptRoot "WonRemote-Android-Log-$stamp"
  New-Item -ItemType Directory -Path $directory | Out-Null
  return $directory
}

if ($SelfTest) {
  $path = New-CaptureDirectory
  if (-not (Test-Path $path)) { throw "캡처 폴더 생성 실패" }
  Remove-Item -LiteralPath $path -Force
  Write-Output "Self-test passed."
  exit 0
}

$adb = Get-AdbPath
$device = (& $adb devices | Select-String "\tdevice$" | Select-Object -First 1).ToString().Split("`t")[0]
if ([string]::IsNullOrWhiteSpace($device)) {
  throw "USB 디버깅을 허용한 Android 기기를 연결한 뒤 다시 실행하세요."
}

$output = New-CaptureDirectory
& $adb -s $device logcat -c
Write-Host "로그를 비웠습니다. PC Viewer에서 첫 접속과 두 번째 접속을 재현한 뒤 Enter를 누르세요."
[void](Read-Host)

& $adb -s $device get-state | Out-File (Join-Path $output "adb-state.txt") -Encoding utf8
& $adb -s $device shell getprop | Out-File (Join-Path $output "device-properties.txt") -Encoding utf8
& $adb -s $device shell dumpsys package $AgentPackage | Out-File (Join-Path $output "agent-package.txt") -Encoding utf8
& $adb -s $device logcat -d -v threadtime | Out-File (Join-Path $output "logcat.txt") -Encoding utf8
& $adb -s $device logcat -d -v threadtime AndroidRuntime:E "WonRemote*:V" "*:S" |
  Out-File (Join-Path $output "wonremote-crash-filtered.txt") -Encoding utf8

$zip = "$output.zip"
Compress-Archive -Path (Join-Path $output "*") -DestinationPath $zip -Force
Write-Host "완료: $zip"
