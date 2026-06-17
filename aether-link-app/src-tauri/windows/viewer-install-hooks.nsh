!include LogicLib.nsh
!include x64.nsh

!macro WONREMOTE_REQUIRE_X64_WINDOWS
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "WonRemote requires 64-bit Windows. This installer cannot run on 32-bit Windows."
    Abort
  ${EndIf}
!macroend

!macro WONREMOTE_STOP_RUNNING_PROCESSES
  DetailPrint "Stopping running WonRemote processes before install..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$targets = Get-Process | Where-Object { if ($_.ProcessName -in @(''wonremote-viewer'',''WonRemote Agent'',''wonremote-poc'')) { $true } elseif ($_.ProcessName -eq ''node'') { $path = ''''; try { $path = $_.Path } catch {}; $path -like ''*\WonRemote\*'' -or $path -like ''*WonRemote Viewer*'' -or $path -like ''*WonRemote Agent*'' } else { $false } }; foreach ($p in $targets) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 1500"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WONREMOTE_REQUIRE_X64_WINDOWS
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  StrCpy $INSTDIR "$LOCALAPPDATA\WonRemote\Viewer"
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend
