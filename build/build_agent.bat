@echo off
setlocal
cd /d C:\WonRemote
node scripts\bump-version.mjs agent
npm run dist:agent
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo Build failed with code %EXITCODE%
  exit /b %EXITCODE%
)
echo Build completed.
