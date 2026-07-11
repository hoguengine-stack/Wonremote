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
  StrCpy $INSTDIR "$LOCALAPPDATA\WonRemote\Agent"
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Starting WonRemote Agent..."
  CreateDirectory "$SMPROGRAMS\WonRemote"
  CreateShortCut "$DESKTOP\WonRemote Agent.lnk" "$INSTDIR\wonremote-viewer.exe" "--agent --show-window"
  CreateShortCut "$SMPROGRAMS\WonRemote\WonRemote Agent.lnk" "$INSTDIR\wonremote-viewer.exe" "--agent --show-window"
  Exec '"$INSTDIR\wonremote-viewer.exe" --agent --show-window'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WonRemoteAgent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WonRemoteAgentCLI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AetherLinkAgent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AetherLinkAgentCLI"
  Delete "$DESKTOP\WonRemote Agent.lnk"
  Delete "$SMPROGRAMS\WonRemote\WonRemote Agent.lnk"
!macroend
