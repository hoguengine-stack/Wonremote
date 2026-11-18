import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractBuildToolZip, runBundledX86AgentWebRtcSmoke } from "./build-backend.js";

it.skipIf(process.platform !== "win32")("extracts a fresh Windows build tool zip and rejects a missing expected binary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wonremote extract "));
  try {
    const archive = path.join(root, "build tool.zip");
    const destination = path.join(root, "extracted tools");
    const tool = path.join(destination, "tool.exe");
    writeFileSync(path.join(root, "tool.exe"), "build tool fixture");
    mkdirSync(destination);
    execFileSync("tar.exe", ["-a", "-cf", archive, "-C", root, "tool.exe"], { windowsHide: true });

    extractBuildToolZip(archive, destination, tool);
    expect(readFileSync(tool, "utf8")).toBe("build tool fixture");
    expect(() => extractBuildToolZip(archive, destination, path.join(destination, "missing.exe")))
      .toThrow(/Extracted build tool is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
