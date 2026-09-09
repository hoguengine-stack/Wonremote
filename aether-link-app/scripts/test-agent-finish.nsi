Unicode true
!include MUI2.nsh
!include "${__FILEDIR__}\..\src-tauri\windows\agent-login-task.nsh"
!addplugindir "${PLUGINPATH}"
OutFile "${TESTOUTPUT}"
RequestExecutionLevel user
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
Section
SectionEnd
