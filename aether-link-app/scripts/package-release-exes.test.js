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
    ["viewer", "viewer", "Viewer", "Agent"],
    ["agent", "agent", "Agent", "Viewer"],
  ])("keeps the %s wrapper product-isolated while selecting the host architecture", (mode, filename, product, otherProduct) => {
    const script = createUniversalProductInstallerScript(packages, mode, `C:\\release\\WonRemote-${product}-Setup.exe`);

    expect(script).toContain("${RunningX64}");
    expect(script).toContain(`${filename}-x64.exe`);
    expect(script).toContain(`${filename}-x86.exe`);
    expect(script).toContain(`WonRemote\\${product}`);
    expect(script).not.toContain(`WonRemote\\${otherProduct}`);
    expect(script).not.toContain("WONREMOTE_RESTART_MODE");
    expect(script).toContain("IfSilent +2 0");
  });
});
