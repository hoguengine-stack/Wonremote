import { describe, expect, it } from "vitest";
import { createUniversalProductInstallerScript } from "./package-release-exes.js";

const packages = {
  x64: {
    agentInstallerPath: "C:\\build\\agent-x64.exe",
    viewerInstallerPath: "C:\\build\\viewer-x64.exe",
  },
  x86: {
    agentInstallerPath: "C:\\build\\agent-x86.exe",
    viewerInstallerPath: "C:\\build\\viewer-x86.exe",
  },
};

describe("universal release installer wrappers", () => {
  it.each([
    ["viewer", "viewer", "Viewer"],
    ["agent", "agent", "Agent"],
  ])("keeps the %s wrapper payload product-isolated while selecting the host architecture", (mode, filename, product) => {
    const script = createUniversalProductInstallerScript(packages, mode, `C:\\release\\WonRemote-${product}-Setup.exe`);

    expect(script).toContain("${RunningX64}");
    expect(script).toContain(`${filename}-x64.exe`);
    expect(script).toContain(`${filename}-x86.exe`);
    expect(script).not.toContain(`${mode === "viewer" ? "agent" : "viewer"}-x64.exe`);
    expect(script).not.toContain(`${mode === "viewer" ? "agent" : "viewer"}-x86.exe`);
    expect(script).not.toContain("WONREMOTE_RESTART_MODE");
    expect(script).toContain("IfSilent +2 0");
  });

  it("restarts an installed Agent after Viewer replacement without embedding an Agent installer", () => {
    const script = createUniversalProductInstallerScript(packages, "viewer", "C:\\release\\WonRemote-Viewer-Setup.exe");

    expect(script).toContain('IfFileExists "$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe"');
    expect(script).toContain('Exec \'"$LOCALAPPDATA\\WonRemote\\Agent\\wonremote-viewer.exe" --agent\'');
    expect(script).not.toContain("agent-x64.exe");
    expect(script).not.toContain("agent-x86.exe");
  });
});
