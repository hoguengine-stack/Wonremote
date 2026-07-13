import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_ONCE_EXIT,
  UpdateOnceError,
  launchInstallerHandoff,
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
    downloadPortable: vi.fn(async () => ({
      archivePath: "C:\\Temp\\WonRemote-Viewer-Agent-Portable.zip",
      latestVersion: "9.9.9",
      packageKind: "portable" as const,
    })),
    prepareHandoff: vi.fn(async () => ({
      args: ["-File", "handoff.ps1"],
      command: "powershell.exe",
      creationFlags: 1,
      logPath: "handoff.log",
      scriptPath: "handoff.ps1",
    })),
    preparePortableHandoff: vi.fn(async () => ({
      args: ["-File", "portable-handoff.ps1"],
      command: "powershell.exe",
      creationFlags: 1,
      logPath: "portable-handoff.log",
      scriptPath: "portable-handoff.ps1",
    })),
    launchHandoff: vi.fn(),
    ...overrides,
  };
}

describe("non-interactive bundled updater", () => {
  it("asks the Tauri broker to launch the handoff when direct child breakaway is unsafe", () => {
    const writeBrokerRequest = vi.fn();
    launchInstallerHandoff({
      args: ["-File", "C:\\Data\\WonRemote\\updates\\run-installer-update-test.ps1"],
      command: "powershell.exe",
      creationFlags: 1,
      logPath: "C:\\Data\\WonRemote\\updates\\handoff.log",
      scriptPath: "C:\\Data\\WonRemote\\updates\\run-installer-update-test.ps1",
    }, { WONREMOTE_TAURI_UPDATE_BROKER: "1" }, writeBrokerRequest);

    expect(writeBrokerRequest).toHaveBeenCalledWith(
      expect.stringMatching(/^\[WonRemoteUpdateHandoff\][A-Za-z0-9_-]+$/),
    );
  });

  it("requires an explicit viewer or agent restart mode", () => {
    expect(parseUpdateOnceOptions(["--update-once", "--restart-mode", "viewer"], { APPDATA: "C:\\Data" })).toEqual({
      baseDir: "C:\\Data",
      restartMode: "viewer",
    });
    expect(parseUpdateOnceOptions(["--update-once", "--restart-mode", "agent"], {
      APPDATA: "C:\\Data",
      WONREMOTE_APP_DIR: "C:\\Portable",
      WONREMOTE_PACKAGE_KIND: "portable-agent",
    })).toEqual({
      baseDir: "C:\\Data",
      portableRoot: "C:\\Portable",
      restartMode: "agent",
    });
    expect(() => parseUpdateOnceOptions(["--update-once"], {})).toThrow(UpdateOnceError);
    expect(parseUpdateOnceOptions([
      "--update-once",
      "--restart-mode",
      "agent",
      "--restart-executable",
      "C:\\WonRemote\\Agent.exe",
    ], { APPDATA: "C:\\Data" })).toMatchObject({
      restartMode: "agent",
      restartExecutablePath: "C:\\WonRemote\\Agent.exe",
    });
    try {
      parseUpdateOnceOptions(["--update-once", "--restart-mode", "bad"], {});
    } catch (error) {
      expect((error as UpdateOnceError).exitCode).toBe(UPDATE_ONCE_EXIT.invalidArguments);
    }
  });

  it("passes the explicit restart executable path into Agent handoff preparation", async () => {
    const deps = updateDeps();
    await runUpdateOnce({
      baseDir: "C:\\Data",
      restartMode: "agent",
      restartExecutablePath: "C:\\WonRemote\\Agent.exe",
    } as any, deps as any);
    expect(deps.prepareHandoff).toHaveBeenCalledWith(expect.anything(), {
      baseDir: "C:\\Data",
      restartMode: "agent",
      restartExecutablePath: "C:\\WonRemote\\Agent.exe",
    });
  });

  it("keeps a portable Agent on the signed Agent-only ZIP update path", async () => {
    const portableMetadata = {
      ...metadata,
      assetName: "WonRemote-Agent-Portable.zip",
      downloadUrl: "https://example.com/WonRemote-Agent-Portable.zip",
      updateKind: "portable-agent" as const,
    };
    const deps = updateDeps({ loadMetadata: vi.fn(async () => portableMetadata) });

    await expect(runUpdateOnce({
      baseDir: "C:\\Data",
      portableRoot: "C:\\Portable",
      restartMode: "agent",
    }, deps as any)).resolves.toMatchObject({ status: "handoff-started" });

    expect(deps.downloadPortable).toHaveBeenCalledWith(portableMetadata, { baseDir: "C:\\Data" });
    expect(deps.downloadInstaller).not.toHaveBeenCalled();
    expect(deps.preparePortableHandoff).toHaveBeenCalledWith(expect.anything(), {
      baseDir: "C:\\Data",
      portableRoot: "C:\\Portable",
      restartMode: "agent",
    });
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
