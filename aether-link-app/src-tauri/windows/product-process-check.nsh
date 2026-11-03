; Agent and Viewer share a basename. Keep the path-scoped stop/postcondition,
; never Tauri's global executable-name kill (including the other product).
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!endif
!macro CheckIfAppIsRunning executableName productName
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
!macroend
