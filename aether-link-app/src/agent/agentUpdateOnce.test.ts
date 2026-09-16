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
      installerSha256: "a".repeat(64),
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
      installerSha256: "a".repeat(64),
      logPath: "handoff.log",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      scriptSha256: "b".repeat(64),
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
  it("requires an explicit stable rollback version and rejects portable rollback", () => {
    expect(parseUpdateOnceOptions(["--update-once", "--restart-mode", "agent", "--rollback-version", "0.1.90"], {})).toMatchObject({ rollbackVersion: "0.1.90" });
    for (const args of [["--rollback-version"], ["--rollback-version", "../latest"], ["--rollback-version", "0.1.90", "--rollback-version", "0.1.89"]]) {
      expect(() => parseUpdateOnceOptions(["--restart-mode", "agent", ...args], {})).toThrow(UpdateOnceError);
    }
    expect(() => parseUpdateOnceOptions(["--restart-mode", "agent", "--rollback-version", "0.1.90"], { WONREMOTE_PACKAGE_KIND: "portable-agent" })).toThrow(UpdateOnceError);
  });
  it("hands off only verified explicit rollback metadata and pins the expected restart version", async () => {
    const old = { ...metadata, latestVersion: "0.1.90" };
    const loadRollbackMetadata = vi.fn(async () => old);
    const deps = updateDeps({ currentVersion: "0.2.0", loadRollbackMetadata });
    const result = await runUpdateOnce({ baseDir: "C:\\Data", restartMode: "agent", rollbackVersion: "0.1.90" }, deps as any);
    expect(result).toEqual({ status: "handoff-started", latestVersion: "0.1.90" });
    expect(deps.loadMetadata).not.toHaveBeenCalled();
    expect(loadRollbackMetadata).toHaveBeenCalledWith("0.1.90", "0.2.0", expect.objectContaining({ WONREMOTE_UPDATE_PRODUCT: "agent" }));
    expect(deps.downloadInstaller).toHaveBeenCalledWith(old, { baseDir: "C:\\Data" });
    expect(deps.prepareHandoff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetVersion: "0.1.90" }));
    expect(deps.launchHandoff).toHaveBeenCalledTimes(1);
  });
  it("does not download or launch a mismatching rollback target", async () => {
    const deps = updateDeps({ currentVersion: "0.2.0", loadRollbackMetadata: vi.fn(async () => metadata) });
    await expect(runUpdateOnce({ baseDir: "C:\\Data", restartMode: "agent", rollbackVersion: "0.1.90" }, deps as any)).rejects.toThrow("Rollback target");
    expect(deps.downloadInstaller).not.toHaveBeenCalled();
    expect(deps.launchHandoff).not.toHaveBeenCalled();
  });
  it("asks the Tauri broker to launch the handoff when direct child breakaway is unsafe", () => {
    const writeBrokerRequest = vi.fn();
    launchInstallerHandoff({
      args: ["-File", "C:\\Data\\WonRemote\\updates\\run-installer-update-test.ps1"],
      command: "powershell.exe",
      creationFlags: 1,
      installerSha256: "a".repeat(64),
      logPath: "C:\\Data\\WonRemote\\updates\\handoff.log",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      scriptSha256: "b".repeat(64),
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
