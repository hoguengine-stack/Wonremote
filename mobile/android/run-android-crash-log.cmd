@echo off
powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File "%~dp0collect-android-crash-log.ps1"
