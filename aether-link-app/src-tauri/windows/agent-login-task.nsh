!include LogicLib.nsh
!define WONREMOTE_AGENT_TASK_HOOK_DIR "${__FILEDIR__}"

!macro WONREMOTE_MANAGE_AGENT_LOGIN_TASK MODE
  Push $0
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\manage-agent-login-task.ps1 "${WONREMOTE_AGENT_TASK_HOOK_DIR}\manage-agent-login-task.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\manage-agent-login-task.ps1" -Mode ${MODE} -AgentPath "$INSTDIR\wonremote-viewer.exe"'
  Delete "$PLUGINSDIR\manage-agent-login-task.ps1"
  Pop $1
  ${If} $1 != 0
    DetailPrint "Failed to configure the WonRemote Agent login task (exit code: $1)."
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
