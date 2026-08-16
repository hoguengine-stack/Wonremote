import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runBundledX86AgentWebRtcSmoke } from "./build-backend.js";

describe("bundled x86 Agent WebRTC smoke", () => {
  it("launches the bundled x86 Node runtime against the packaged Agent smoke command", () => {
    const execFile = vi.fn(() => "Agent runtime smoke passed: arch=ia32, webrtc=werift\n");

    runBundledX86AgentWebRtcSmoke({
      ensureFile: vi.fn(),
      execFile,
      rootDir: "C:\\bundle",
    });

    expect(execFile).toHaveBeenCalledWith(
      "C:\\bundle\\dist-runtime\\node.exe",
      ["C:\\bundle\\dist-agent\\index.mjs", "--runtime-smoke"],
      expect.objectContaining({
        cwd: "C:\\bundle\\dist-agent",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("fails when the child does not prove the ia32 werift runtime", () => {
    expect(() => runBundledX86AgentWebRtcSmoke({
      ensureFile: vi.fn(),
      execFile: () => "Agent runtime smoke passed: arch=x64, webrtc=node-datachannel\n",
      rootDir: "C:\\bundle",
    })).toThrow("Bundled x86 Agent WebRTC smoke did not confirm werift runtime");
  });

  it("uses the real artifact existence check when no test dependency is injected", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "wonremote-x86-smoke-"));
    try {
      mkdirSync(path.join(rootDir, "dist-runtime"), { recursive: true });
      mkdirSync(path.join(rootDir, "dist-agent"), { recursive: true });
      writeFileSync(path.join(rootDir, "dist-runtime", "node.exe"), "fixture");
      writeFileSync(path.join(rootDir, "dist-agent", "index.mjs"), "fixture");

      expect(() => runBundledX86AgentWebRtcSmoke({
        execFile: () => "Agent runtime smoke passed: arch=ia32, webrtc=werift\n",
        rootDir,
      })).not.toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
