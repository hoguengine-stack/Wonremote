@echo off
setlocal
set "SCRIPT=%TEMP%\WonRemote-collect-android-crash-log.ps1"
echo Downloading current WonRemote Android crash collector...
del /q "%SCRIPT%" 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/hoguengine-stack/Wonremote/main/mobile/android/collect-android-crash-log.ps1' -OutFile '%SCRIPT%'"
if errorlevel 1 (
  echo Collector download failed. Check the Internet connection and run this file again.
  pause
  exit /b 1
)
if not exist "%SCRIPT%" (
  echo Collector download failed. Check the Internet connection and run this file again.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File "%SCRIPT%"
pause
