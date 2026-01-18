@echo off
setlocal
cd /d C:\WonRemote
node scripts\bump-version.mjs admin
npm run dist:admin
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo Build failed with code %EXITCODE%
  exit /b %EXITCODE%
)
echo Build completed.
