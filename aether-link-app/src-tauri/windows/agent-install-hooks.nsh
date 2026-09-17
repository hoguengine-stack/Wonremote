!include LogicLib.nsh
!include x64.nsh
!include "${__FILEDIR__}\agent-login-task.nsh"

!macro WONREMOTE_REQUIRE_X64_WINDOWS
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "WonRemote requires 64-bit Windows. This installer cannot run on 32-bit Windows."
    Abort
  ${EndIf}
!macroend

!macro WONREMOTE_STOP_RUNNING_PROCESSES
  DetailPrint "Stopping running WonRemote processes before install..."
  Push $0
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\wonremote-stop-processes.ps1 "${__FILEDIR__}\..\..\stop-wonremote-processes.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\wonremote-stop-processes.ps1" -Product Agent -InstallRoot "$INSTDIR"'
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
  !insertmacro WONREMOTE_REQUIRE_X64_WINDOWS
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  File /oname=$INSTDIR\manage-agent-login-task.ps1 "${WONREMOTE_AGENT_TASK_HOOK_DIR}\manage-agent-login-task.ps1"
  File /oname=$INSTDIR\agent-update-health.ps1 "${WONREMOTE_AGENT_TASK_HOOK_DIR}\agent-update-health.ps1"
  File /oname=$INSTDIR\update-handoff-broker.ps1 "${WONREMOTE_AGENT_TASK_HOOK_DIR}\update-handoff-broker.ps1"
  !insertmacro WONREMOTE_MIGRATE_LEGACY_AGENT
  CreateDirectory "$SMPROGRAMS\WonRemote"
  CreateShortCut "$DESKTOP\WonRemote Agent.lnk" "$INSTDIR\wonremote-viewer.exe" "--agent --show-window"
  CreateShortCut "$SMPROGRAMS\WonRemote\WonRemote Agent.lnk" "$INSTDIR\wonremote-viewer.exe" "--agent --show-window"
  ${If} ${Silent}
    DetailPrint "Starting the installed WonRemote Agent after silent update..."
    nsis_tauri_utils::RunAsUser "$INSTDIR\wonremote-viewer.exe" "--agent"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WONREMOTE_MANAGE_AGENT_LOGIN_TASK Uninstall
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  Delete "$INSTDIR\manage-agent-login-task.ps1"
  Delete "$INSTDIR\agent-update-health.ps1"
  Delete "$INSTDIR\update-handoff-broker.ps1"
  RMDir /r "$INSTDIR\.update-handoff"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WonRemoteAgent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WonRemoteAgentCLI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AetherLinkAgent"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AetherLinkAgentCLI"
  Delete "$DESKTOP\WonRemote Agent.lnk"
  Delete "$SMPROGRAMS\WonRemote\WonRemote Agent.lnk"
!macroend
