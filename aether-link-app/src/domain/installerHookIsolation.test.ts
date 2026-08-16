import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..", "..");
const windowsRoot = path.join(projectRoot, "src-tauri", "windows");

const hookCases = [
  { filename: "agent-install-hooks.nsh", product: "Agent" },
  { filename: "agent-install-hooks-x86.nsh", product: "Agent" },
  { filename: "viewer-install-hooks.nsh", product: "Viewer" },
  { filename: "viewer-install-hooks-x86.nsh", product: "Viewer" },
] as const;

describe("NSIS installer process isolation", () => {
  it("uses one shared architecture-neutral PowerShell process stopper with no inline command execution", () => {
    for (const hookCase of hookCases) {
      const source = readFileSync(path.join(windowsRoot, hookCase.filename), "utf8");

      expect(source).toContain("stop-wonremote-processes.ps1");
      expect(source).toMatch(/\bFile\b[^\r\n]*stop-wonremote-processes\.ps1/i);
      expect(source).toContain("${__FILEDIR__}\\..\\..\\stop-wonremote-processes.ps1");
      expect(source).not.toMatch(/-Command\s+['\"]|\btaskkill\b|\bGet-Process\b/i);
      expect(source).toMatch(new RegExp(`-Product\\s+[\"']?${hookCase.product}[\"']?`, "i"));
      expect(source).not.toMatch(/-Architecture\b/i);
    }
  });

  it("keeps the shared stopper scoped to the exact product install root across executable architectures", () => {
    const source = readFileSync(path.join(windowsRoot, "stop-wonremote-processes.ps1"), "utf8");

    expect(source).toContain("param(");
    expect(source).toMatch(/\[ValidateSet\(['\"]Agent['\"],\s*['\"]Viewer['\"]\)\][\s\S]*?\[string\]\s*\$Product/i);
    expect(source).not.toContain("$Architecture");
    expect(source).not.toContain("Test-TargetArchitecture");
    expect(source).toContain("$env:LOCALAPPDATA");
    expect(source).toContain("WonRemote");
    expect(source).toContain("Get-CimInstance Win32_Process");
    expect(source).toContain("ExecutablePath");
    expect(source).toContain("GetFullPath");
    expect(source).toMatch(/StartsWith\([^\r\n]*OrdinalIgnoreCase/);
    expect(source).toContain("ParentProcessId");
    expect(source).toContain("targetIds.Contains");
    expect(source).toContain("Stop-Process -Id");
    expect(source).toMatch(/Start-Sleep\s+-Milliseconds\s+\d+/i);
    expect(source).toContain("remainingIds");
    expect(source).toContain("process termination failed");

    const buildSource = readFileSync(path.join(projectRoot, "src-tauri", "build.rs"), "utf8");
    expect(buildSource).toContain("stage_installer_process_stop_script");
    expect(buildSource).toContain('profile_dir.join("stop-wonremote-processes.ps1")');
  });
});
