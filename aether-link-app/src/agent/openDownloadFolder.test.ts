import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAgentDownloadFolder } from "./openDownloadFolder";
import { executeAgentCommand, type AgentCommandRuntime } from "./agentCommandExecution";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

describe("remote receive folder", () => {
  afterEach(() => vi.clearAllMocks());
  it.each(["poll", "webrtc"] as const)("opens the configured real receive root through %s without shell/path arguments", async (source) => {
    const root = await mkdtemp(path.join(tmpdir(), "wonremote-folder-"));
    const folder = path.join(root, "received & files");
    await mkdir(folder);
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mock.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
    const runtime = {
      getActiveSessionId: () => "active", openDownloadFolder: () => openAgentDownloadFolder({
        SystemRoot: "C:\\Windows", WONREMOTE_AGENT_DOWNLOADS_DIR: folder,
      }, "win32"),
    } as AgentCommandRuntime;
    try {
      await expect(executeAgentCommand("open-download-folder", source, runtime)).resolves.toBe("executed");
      expect(mock.spawn).toHaveBeenCalledExactlyOnceWith("C:\\Windows\\explorer.exe", [folder], {
        shell: false, stdio: "ignore", windowsHide: false,
      });
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("spawn")).toBe(0);
      expect(child.unref).toHaveBeenCalledOnce();
      await expect(executeAgentCommand("open-download-folder C:\\other", source, runtime)).resolves.toBe("rejected");
      runtime.getActiveSessionId = () => null;
      await expect(executeAgentCommand("open-download-folder", source, runtime)).resolves.toBe("ignored");
      expect(mock.spawn).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reports launch errors and removes the pending spawn handler", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mock.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("error", new Error("launch failed"))); return child; });
    await expect(openAgentDownloadFolder({SystemRoot: "C:\\Windows", WONREMOTE_AGENT_DOWNLOADS_DIR: tmpdir()}, "win32")).rejects.toThrow("launch failed");
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.unref).not.toHaveBeenCalled();
  });
  it("does not launch on unsupported platforms or absent folders", async () => {
    await expect(openAgentDownloadFolder({}, "linux")).rejects.toThrow("requires Windows");
    await expect(openAgentDownloadFolder({WONREMOTE_AGENT_DOWNLOADS_DIR:path.join(tmpdir(), "absent", "receive-root")}, "win32")).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
  });
});
