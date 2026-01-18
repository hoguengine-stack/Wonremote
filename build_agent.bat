@echo off
setlocal

cd /d "%~dp0"

set LOGDIR=build\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
set LOGFILE=%LOGDIR%\agent_build_%TS%.log
echo Logging to %LOGFILE%

node scripts\bump-version.mjs agent >> "%LOGFILE%" 2>&1
if errorlevel 1 goto fail

echo [1/1] Building agent installer (npm run dist:agent)... >> "%LOGFILE%"
npm run dist:agent >> "%LOGFILE%" 2>&1
if errorlevel 1 goto fail

echo Build completed. >> "%LOGFILE%"
echo Build completed. See log: %LOGFILE%
exit /b 0

:fail
set EXITCODE=%ERRORLEVEL%
echo Build failed with code %EXITCODE% >> "%LOGFILE%"
echo Build failed with code %EXITCODE%. See log: %LOGFILE%
exit /b %EXITCODE%
