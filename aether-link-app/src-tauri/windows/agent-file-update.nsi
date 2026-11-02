Unicode true
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
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${UPDATE_PAYLOAD}\*"
  SetOutPath "$PLUGINSDIR"
  File "${__FILEDIR__}\agent-file-update.ps1"
  File "${__FILEDIR__}\stop-wonremote-processes.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\agent-file-update.ps1" -PayloadRoot "$PLUGINSDIR\payload"'
  Pop $0
  StrCmp $0 "0" success
  SetErrorLevel 1
  Quit
success:
  SetErrorLevel 0
SectionEnd
