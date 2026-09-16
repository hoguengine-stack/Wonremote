!include LogicLib.nsh
!define WONREMOTE_AGENT_TASK_HOOK_DIR "${__FILEDIR__}"

; Keep the stock finish page, with deterministic Agent actions instead of choices.
!macroundef MUI_PAGE_FINISH
!macro MUI_PAGE_FINISH
  !undef MUI_FINISHPAGE_RUN
  !undef MUI_FINISHPAGE_RUN_FUNCTION
  !undef MUI_FINISHPAGE_SHOWREADME
  !undef MUI_FINISHPAGE_SHOWREADME_TEXT
  !undef MUI_FINISHPAGE_SHOWREADME_FUNCTION
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE WonRemoteAgentFinish
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_PAGEDECLARATION_FINISH
  Function WonRemoteAgentFinish
    nsis_tauri_utils::RunAsUser "$INSTDIR\wonremote-viewer.exe" "--agent --show-window"
  FunctionEnd
!macroend

!macro WONREMOTE_MANAGE_AGENT_LOGIN_TASK MODE
  Push $0
  Push $1
  InitPluginsDir
  IfFileExists "$INSTDIR\manage-agent-login-task.ps1" 0 +3
  StrCpy $0 "$INSTDIR\manage-agent-login-task.ps1"
  Goto +3
  File /oname=$PLUGINSDIR\manage-agent-login-task.ps1 "${WONREMOTE_AGENT_TASK_HOOK_DIR}\manage-agent-login-task.ps1"
  StrCpy $0 "$PLUGINSDIR\manage-agent-login-task.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$0" -Mode ${MODE} -AgentPath "$INSTDIR\wonremote-viewer.exe"'
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

!macro WONREMOTE_MIGRATE_LEGACY_AGENT
  Push $0
  Push $1
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\manage-agent-login-task.ps1" -Mode Migrate -AgentPath "$INSTDIR\wonremote-viewer.exe"'
  Pop $1
  ${If} $1 != 0
    DetailPrint "Failed to configure or migrate the WonRemote Agent (exit code: $1)."
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
