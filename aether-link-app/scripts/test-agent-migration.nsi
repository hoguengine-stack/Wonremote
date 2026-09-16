Unicode true
!include MUI2.nsh
!include "${__FILEDIR__}\..\src-tauri\windows\agent-login-task.nsh"
!addplugindir "${PLUGINPATH}"
OutFile "${TESTOUTPUT}"
RequestExecutionLevel admin
Section
  StrCpy $INSTDIR "$TEMP\WonRemote Agent"
  !insertmacro WONREMOTE_MIGRATE_LEGACY_AGENT
SectionEnd
