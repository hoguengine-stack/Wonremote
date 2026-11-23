Unicode true
!include "FileFunc.nsh"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor /SOLID zlib
Name "WonRemote Agent File Update"
OutFile "${UPDATE_OUTPUT}"
VIProductVersion "${UPDATE_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "WonRemote Agent File Update"
VIAddVersionKey /LANG=1033 "ProductVersion" "${UPDATE_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "WonRemote"
VIAddVersionKey /LANG=1033 "FileDescription" "Protected Agent file replacement (not Setup)"
VIAddVersionKey /LANG=1033 "FileVersion" "${UPDATE_VERSION}"

Section
  ${GetParameters} $1
  ClearErrors
  ${GetOptions} $1 "/FIRSTHOP=" $2
  IfErrors brokered_stage
  StrCmp $2 "" failure
  # Reserve the extraction path in Program Files before any helper code runs.
  GetTempFileName $3 "$PROGRAMFILES32"
  IfErrors failure
  StrCpy $4 "$3.wonremote-firsthop"
  IfFileExists "$4\." release_reservation
  CreateDirectory "$4"
  IfErrors release_reservation
  Goto extract_payload
brokered_stage:
  InitPluginsDir
  StrCpy $4 "$PLUGINSDIR"
extract_payload:
  ClearErrors
  SetOutPath "$4\payload"
  File /r "${UPDATE_PAYLOAD}\*"
  IfErrors extract_failed
  StrCmp $3 "" brokered_update
  ExecWait '"$4\payload\wonremote-viewer.exe" --legacy-agent-first-hop "$2" "$EXEPATH"' $0
  IfErrors extract_failed
  Goto clean_first_hop
brokered_update:
  SetOutPath "$PLUGINSDIR"
  File "${__FILEDIR__}\agent-file-update.ps1"
  File "${__FILEDIR__}\stop-wonremote-processes.ps1"
  IfErrors failure
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\agent-file-update.ps1" -PayloadRoot "$PLUGINSDIR\payload" -InstallerProcessId $0'
  Pop $0
  Goto result
extract_failed:
  StrCpy $0 1
  StrCmp $3 "" result
clean_first_hop:
  SetOutPath "$PROGRAMFILES32"
  RMDir /r "$4"
  Delete "$3"
  Goto result
release_reservation:
  Delete "$3"
  Goto failure
result:
  StrCmp $0 "0" success
failure:
  SetErrorLevel 1
  Quit
success:
  SetErrorLevel 0
SectionEnd
