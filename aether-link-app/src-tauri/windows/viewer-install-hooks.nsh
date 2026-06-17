!macro WONREMOTE_STOP_RUNNING_PROCESSES
  DetailPrint "Stopping running WonRemote processes before install..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$targets = Get-Process | Where-Object { if ($_.ProcessName -in @(''wonremote-viewer'',''WonRemote Agent'',''wonremote-poc'')) { $true } elseif ($_.ProcessName -eq ''node'') { $path = ''''; try { $path = $_.Path } catch {}; $path -like ''*\WonRemote\*'' -or $path -like ''*WonRemote Viewer*'' -or $path -like ''*WonRemote Agent*'' } else { $false } }; foreach ($p in $targets) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 1500"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  StrCpy $INSTDIR "$LOCALAPPDATA\WonRemote\Viewer"
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend
