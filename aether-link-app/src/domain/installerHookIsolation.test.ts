import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..", "..");

const hookCases = [
  {
    expectedMachine: 34404,
    filename: "agent-install-hooks.nsh",
    ownRoot: "WonRemote\\Agent",
    otherRoot: "WonRemote\\Viewer",
  },
  {
    expectedMachine: 332,
    filename: "agent-install-hooks-x86.nsh",
    ownRoot: "WonRemote\\Agent",
    otherRoot: "WonRemote\\Viewer",
  },
  {
    expectedMachine: 34404,
    filename: "viewer-install-hooks.nsh",
    ownRoot: "WonRemote\\Viewer",
    otherRoot: "WonRemote\\Agent",
  },
  {
    expectedMachine: 332,
    filename: "viewer-install-hooks-x86.nsh",
    ownRoot: "WonRemote\\Viewer",
    otherRoot: "WonRemote\\Agent",
  },
] as const;

describe("NSIS installer process isolation", () => {
  for (const hookCase of hookCases) {
    it(`${hookCase.filename} stops only processes rooted in its own install directory`, () => {
      const source = readFileSync(
        path.join(projectRoot, "src-tauri", "windows", hookCase.filename),
        "utf8",
      );
      const command = source.split(/\r?\n/).find((line) => line.includes("nsExec::ExecToLog")) ?? "";
      const stopMacro = source.match(/!macro WONREMOTE_STOP_RUNNING_PROCESSES([\s\S]*?)!macroend/)?.[1] ?? "";

      expect(source).toContain("!include LogicLib.nsh");
      expect(source).not.toMatch(/\btaskkill\b|\/IM\b/i);
      expect(source).not.toContain("Get-Process");
      expect(source).not.toContain("ProcessName -in");
      expect(source).toContain("Get-CimInstance Win32_Process");
      expect(source).toContain(`Join-Path $$env:LOCALAPPDATA ''${hookCase.ownRoot}''`);
      expect(source).not.toContain(`Join-Path $$env:LOCALAPPDATA ''${hookCase.otherRoot}''`);
      expect(source).toContain("[System.IO.Path]::GetFullPath");
      expect(source).toContain("function Convert-ExtendedPath");
      expect(source).toContain("$$extendedPrefix = -join @([char]92, [char]92, ''?'', [char]92)");
      expect(source).toContain("$$extendedUncPrefix = $$extendedPrefix + ''UNC'' + [char]92");
      expect(source).toContain("return (-join @([char]92, [char]92)) + $$normalized.Substring");
      expect(source).toContain(
        `$$root = Convert-ExtendedPath (Join-Path $$env:LOCALAPPDATA ''${hookCase.ownRoot}'')`,
      );
      expect(source).toContain("$$candidate = Convert-ExtendedPath $$process.ExecutablePath");
      expect(source).not.toContain("$$candidate = [System.IO.Path]::GetFullPath($$process.ExecutablePath)");
      expect(source).toContain("Test-TargetArchitecture");
      expect(source).toContain(`ReadUInt16() -eq ${hookCase.expectedMachine}`);
      expect(source).toContain("[System.IO.Path]::DirectorySeparatorChar");
      expect(source).toContain("StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase)");
      expect(source).toContain("$$id -eq 0");
      expect(source).toContain("$$id -eq $$PID");
      expect(source).toContain("$$id -eq $$installerPid");
      expect(source).toContain("$$targetIds.Contains($$parentId)");
      expect(source).toContain("Stop-Process -Id $$id");
      expect(source).toContain("Start-Sleep -Milliseconds 1500");
      expect(source).toContain("$$remainingIds = @(Get-CimInstance Win32_Process");
      expect(source).toContain("$$targetIds.Contains([int]$$_.ProcessId)");
      expect(source).toContain("if ($$remainingIds.Count -gt 0)");
      expect(source).toContain("process termination failed. Remaining PIDs:");
      expect(stopMacro).toMatch(
        /nsExec::ExecToLog[\s\S]*Pop \$1[\s\S]*\$\{If\} \$1 != 0[\s\S]*SetErrorLevel \$1[\s\S]*Abort/,
      );
      expect(command).not.toMatch(/(?<!\$)\$(?:env:|PID\b|[A-Za-z_][A-Za-z0-9_]*)/);
      expect(source.match(/!insertmacro WONREMOTE_STOP_RUNNING_PROCESSES/g)).toHaveLength(2);
    });
  }
});
