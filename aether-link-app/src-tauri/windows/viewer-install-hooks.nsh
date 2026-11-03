!include LogicLib.nsh
!include "${__FILEDIR__}\product-process-check.nsh"
!include x64.nsh

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
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\wonremote-stop-processes.ps1" -Product Viewer -InstallerProcessId $0'
  Delete "$PLUGINSDIR\wonremote-stop-processes.ps1"
  Pop $1
  ${If} $1 != 0
    DetailPrint "Failed to stop WonRemote Viewer processes (exit code: $1)."
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
  StrCpy $INSTDIR "$LOCALAPPDATA\WonRemote\Viewer"
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
    DetailPrint "Starting the installed WonRemote Viewer after silent update..."
    nsis_tauri_utils::RunAsUser "$INSTDIR\wonremote-viewer.exe" ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WonRemoteViewer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AetherLinkViewer"
!macroend
