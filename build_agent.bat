@echo off
REM Build WonRemote agent installer (client route)
setlocal

REM Move to script directory
cd /d "%~dp0"

node scripts\bump-version.mjs agent

echo [1/1] Building agent installer (npm run dist:agent)...
npm run dist:agent
set ERR=%ERRORLEVEL%

if %ERR% neq 0 (
  echo.
  echo Build failed with exit code %ERR%.
  exit /b %ERR%
)

echo.
echo Build completed. Check the release folder for the installer.
exit /b 0
