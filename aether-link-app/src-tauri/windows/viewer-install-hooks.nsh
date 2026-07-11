!include LogicLib.nsh
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
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = ''Stop''; if ([string]::IsNullOrWhiteSpace($$env:LOCALAPPDATA)) { exit 0 }; function Convert-ExtendedPath([string]$$value) { $$normalized = [System.IO.Path]::GetFullPath($$value).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar); $$extendedPrefix = -join @([char]92, [char]92, ''?'', [char]92); $$extendedUncPrefix = $$extendedPrefix + ''UNC'' + [char]92; if ($$normalized.StartsWith($$extendedUncPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { return (-join @([char]92, [char]92)) + $$normalized.Substring($$extendedUncPrefix.Length) }; if ($$normalized.StartsWith($$extendedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $$normalized.Substring($$extendedPrefix.Length) }; return $$normalized }; $$root = Convert-ExtendedPath (Join-Path $$env:LOCALAPPDATA ''WonRemote\Viewer''); $$prefix = $$root + [System.IO.Path]::DirectorySeparatorChar; function Test-TargetArchitecture([string]$$path) { $$stream = $$null; $$reader = $$null; try { $$stream = [System.IO.File]::Open($$path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)); $$reader = New-Object System.IO.BinaryReader($$stream); $$stream.Position = 60; $$peOffset = $$reader.ReadInt32(); $$stream.Position = $$peOffset + 4; return $$reader.ReadUInt16() -eq 34404 } catch { return $$false } finally { if ($$null -ne $$reader) { $$reader.Dispose() } elseif ($$null -ne $$stream) { $$stream.Dispose() } } }; $$self = Get-CimInstance Win32_Process -Filter (''ProcessId = '' + $$PID) -ErrorAction SilentlyContinue; $$installerPid = if ($$null -ne $$self) { [int]$$self.ParentProcessId } else { -1 }; $$processes = @(Get-CimInstance Win32_Process); $$targetIds = New-Object ''System.Collections.Generic.HashSet[int]''; foreach ($$process in $$processes) { $$id = [int]$$process.ProcessId; if ($$id -eq 0 -or $$id -eq $$PID -or $$id -eq $$installerPid -or [string]::IsNullOrWhiteSpace($$process.ExecutablePath)) { continue }; try { $$candidate = Convert-ExtendedPath $$process.ExecutablePath } catch { continue }; if ($$candidate.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-TargetArchitecture $$candidate)) { [void]$$targetIds.Add($$id) } }; do { $$added = $$false; foreach ($$process in $$processes) { $$id = [int]$$process.ProcessId; $$parentId = [int]$$process.ParentProcessId; if ($$id -eq 0 -or $$id -eq $$PID -or $$id -eq $$installerPid -or $$targetIds.Contains($$id)) { continue }; if ($$targetIds.Contains($$parentId)) { [void]$$targetIds.Add($$id); $$added = $$true } } } while ($$added); foreach ($$process in $$processes) { $$id = [int]$$process.ProcessId; if ($$targetIds.Contains($$id)) { Write-Output (''Stopping WonRemote Viewer PID '' + $$id + '': '' + $$process.ExecutablePath); Stop-Process -Id $$id -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 1500; $$remainingIds = @(Get-CimInstance Win32_Process | Where-Object { $$targetIds.Contains([int]$$_.ProcessId) } | ForEach-Object { [int]$$_.ProcessId }); if ($$remainingIds.Count -gt 0) { throw (''WonRemote Viewer process termination failed. Remaining PIDs: '' + ($$remainingIds -join '','')) }; exit 0"'
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
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  StrCpy $INSTDIR "$LOCALAPPDATA\WonRemote\Viewer"
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WONREMOTE_STOP_RUNNING_PROCESSES
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WonRemoteViewer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AetherLinkViewer"
!macroend
