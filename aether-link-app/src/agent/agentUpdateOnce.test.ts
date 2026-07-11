import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_ONCE_EXIT,
  UpdateOnceError,
  parseUpdateOnceOptions,
  runUpdateOnce,
} from "./agentUpdateOnce";

const metadata = {
  assetName: "WonRemote-Viewer-Agent-Setup.exe",
  checksum: "a".repeat(64),
  downloadUrl: "https://example.com/WonRemote-Viewer-Agent-Setup.exe",
  forceUpdate: false,
  latestVersion: "9.9.9",
  reloadViewer: false,
  signature: "signed",
  updateKind: "installer" as const,
};

function updateDeps(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: "0.1.0",
    loadMetadata: vi.fn(async () => metadata),
    downloadInstaller: vi.fn(async () => ({
      installerArgs: ["/S"],
      installerPath: "C:\\Temp\\WonRemote-Viewer-Agent-Setup.exe",
    })),
    prepareHandoff: vi.fn(async () => ({
      args: ["-File", "handoff.ps1"],
      command: "powershell.exe",
      creationFlags: 1,
      logPath: "handoff.log",
      scriptPath: "handoff.ps1",
    })),
    launchHandoff: vi.fn(),
    ...overrides,
  };
}

describe("non-interactive bundled updater", () => {
  it("requires an explicit viewer or agent restart mode", () => {
    expect(parseUpdateOnceOptions(["--update-once", "--restart-mode", "viewer"], { APPDATA: "C:\\Data" })).toEqual({
      baseDir: "C:\\Data",
      restartMode: "viewer",
    });
    expect(() => parseUpdateOnceOptions(["--update-once"], {})).toThrow(UpdateOnceError);
    try {
      parseUpdateOnceOptions(["--update-once", "--restart-mode", "bad"], {});
    } catch (error) {
      expect((error as UpdateOnceError).exitCode).toBe(UPDATE_ONCE_EXIT.invalidArguments);
    }
  });

  it("verifies, downloads, and hands off an update without Agent configuration", async () => {
    const deps = updateDeps();
    const result = await runUpdateOnce(
      { baseDir: "C:\\Data", restartMode: "viewer" },
      deps as any,
    );

    expect(result).toEqual({ latestVersion: "9.9.9", status: "handoff-started" });
    expect(deps.downloadInstaller).toHaveBeenCalledWith(metadata, { baseDir: "C:\\Data" });
    expect(deps.prepareHandoff).toHaveBeenCalledWith(expect.anything(), {
      baseDir: "C:\\Data",
      restartMode: "viewer",
    });
    expect(deps.launchHandoff).toHaveBeenCalledOnce();
  });

  it("does not download when the installed version is current", async () => {
    const deps = updateDeps({ currentVersion: "9.9.9" });
    await expect(
      runUpdateOnce({ baseDir: "C:\\Data", restartMode: "agent" }, deps as any),
    ).resolves.toEqual({ latestVersion: "9.9.9", status: "up-to-date" });
    expect(deps.downloadInstaller).not.toHaveBeenCalled();
  });

  it("uses a distinct exit classification when metadata is unavailable", async () => {
    const deps = updateDeps({ loadMetadata: vi.fn(async () => null) });
    await expect(
      runUpdateOnce({ baseDir: "C:\\Data", restartMode: "viewer" }, deps as any),
    ).rejects.toMatchObject({ exitCode: UPDATE_ONCE_EXIT.metadataUnavailable });
  });
});
