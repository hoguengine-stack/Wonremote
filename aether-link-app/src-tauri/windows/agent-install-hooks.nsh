!macro WONREMOTE_STOP_RUNNING_PROCESSES
  DetailPrint "Stopping running WonRemote processes before install..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @(''wonremote-viewer.exe'',''WonRemote Agent.exe'',''wonremote-poc.exe'')) -or ($_.Name -eq ''node.exe'' -and ($_.ExecutablePath -like ''*\WonRemote\*'' -or $_.CommandLine -like ''*\WonRemote\*'' -or $_.CommandLine -like ''*WonRemote Viewer*'' -or $_.CommandLine -like ''*wonremote-app*'')) }; foreach ($p in $targets) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 1500"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  StrCpy $INSTDIR "$LOCALAPPDATA\WonRemote\Agent"
!macroend
