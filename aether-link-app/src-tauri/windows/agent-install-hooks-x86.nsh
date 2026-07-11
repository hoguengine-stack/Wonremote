!include LogicLib.nsh

!macro WONREMOTE_STOP_RUNNING_PROCESSES
  DetailPrint "Stopping running WonRemote processes before install..."
  Push $0
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\wonremote-stop-processes.ps1 "${__FILEDIR__}\..\..\stop-wonremote-processes.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\wonremote-stop-processes.ps1" -Product Agent -Architecture x86'
  Delete "$PLUGINSDIR\wonremote-stop-processes.ps1"
  Pop $1
  ${If} $1 != 0
    DetailPrint "Failed to stop WonRemote Agent processes (exit code: $1)."
    ${If} $1 == "error"
      StrCpy $1 1
    ${ElseIf} $1 == "timeout"
      StrCpy $1 1
    ${EndIf}
    SetErrorLevel $1
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
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
