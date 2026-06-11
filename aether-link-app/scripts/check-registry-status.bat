@echo off
setlocal

echo ===================================================
echo   AetherLink Registry and Runtime Status Check
echo ===================================================
echo.

echo [1] HKCU Run registry values
echo ---------------------------------------------------
call :query_run_value AetherLinkAgent "Agent tray mode, expected command includes --agent"
call :query_run_value AetherLinkViewer "Viewer mode"
call :query_run_value AetherLinkAgentCLI "Headless CLI diagnostics only"
echo.

echo [2] Agent local config
echo ---------------------------------------------------
set "config_path=%APPDATA%\AetherLink\agent-config.json"
if exist "%config_path%" (
    echo [OK] Config file: %config_path%
    type "%config_path%"
) else (
    echo [WARN] Config file not found: %config_path%
)
echo.

echo [3] Running AetherLink processes
echo ---------------------------------------------------
call :show_process aether-link-viewer.exe
call :show_process node.exe
call :show_process aether-link-poc.exe
echo.

echo Done.
if /i "%AETHER_LINK_STATUS_PAUSE%"=="1" pause
exit /b 0

:query_run_value
set "value_name=%~1"
set "description=%~2"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "%value_name%" 2>nul
if errorlevel 1 (
    echo [INFO] %value_name% not registered. %description%
) else (
    echo [OK] %value_name% registered. %description%
)
echo.
exit /b 0

:show_process
set "image_name=%~1"
tasklist /FI "IMAGENAME eq %image_name%" 2>nul | findstr /i "%image_name%" >nul
if errorlevel 1 (
    echo [STOPPED] %image_name%
) else (
    echo [RUNNING] %image_name%
    tasklist /FI "IMAGENAME eq %image_name%"
)
echo.
exit /b 0
