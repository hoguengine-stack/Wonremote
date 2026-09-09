import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  nextSecureDesktopCaptureState,
  resolveAgentAppDir,
  resolveAgentCaptureSpawnPlan,
  resolveAgentPocPath,
} from "./agentPaths";

describe("agent runtime paths", () => {
  it("uses WONREMOTE_APP_DIR to isolate the app update target", () => {
    const fixtureDir = path.resolve("C:/tmp/aether-link-fixture-app");

    expect(
      resolveAgentAppDir(
        {
          WONREMOTE_APP_DIR: fixtureDir,
        },
        "C:/real/aether-link-app",
      ),
    ).toBe(fixtureDir);
  });

  it("uses WONREMOTE_POC_PATH to keep E2E fixtures independent from the repo layout", () => {
    const pocPath = path.resolve("C:/tmp/wonremote-poc.exe");

    expect(
      resolveAgentPocPath(
        {
          WONREMOTE_POC_PATH: pocPath,
        },
        "C:/tmp/aether-link-fixture-app",
      ),
    ).toBe(pocPath);
  });

  it("falls back to local bin folder in packaged agent layout", () => {
    const fs = require("node:fs");
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p: any) => p.includes("bin"));

    try {
      const resolved = resolveAgentPocPath({}, "C:/tmp/packaged-agent");
      expect(resolved).toBe(path.resolve("C:/tmp/packaged-agent/bin/wonremote-poc.exe"));
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to parent bin folder in Tauri resource dir layout", () => {
    const fs = require("node:fs");
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      const normalized = p.replace(/\\/g, "/");
      return normalized.includes("tmp/resources/bin");
    });

    try {
      const resolved = resolveAgentPocPath({}, "C:/tmp/resources/app");
      expect(resolved).toBe(path.resolve("C:/tmp/resources/bin/wonremote-poc.exe"));
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the protected active-console broker for every installed capture", () => {
    const directArgs = ["--mode", "stream", "--output-index", "0"];

    expect(resolveAgentCaptureSpawnPlan({}, directArgs, false)).toEqual({
      args: [
        "--mode",
        "secure-client",
        "--output-index",
        "0",
      ],
      secure: true,
    });
    expect(resolveAgentCaptureSpawnPlan({}, directArgs, true)).toEqual({
      args: [
        "--mode",
        "secure-client",
        "--output-index",
        "0",
      ],
      secure: true,
    });
  });

  it("switches capture in both desktop directions and resets it for a new session", () => {
    expect(nextSecureDesktopCaptureState(false, false, "secure-desktop-required")).toBe(true);
    expect(nextSecureDesktopCaptureState(true, false, "frame")).toBe(true);
    expect(nextSecureDesktopCaptureState(true, false, "default-desktop-required")).toBe(false);
    expect(nextSecureDesktopCaptureState(true, true)).toBe(false);
  });
});
