import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentAppDir, resolveAgentPocPath } from "./agentPaths";

describe("agent runtime paths", () => {
  it("uses AETHER_LINK_APP_DIR to isolate the app update target", () => {
    const fixtureDir = path.resolve("C:/tmp/aether-link-fixture-app");

    expect(
      resolveAgentAppDir(
        {
          AETHER_LINK_APP_DIR: fixtureDir,
        },
        "C:/real/aether-link-app",
      ),
    ).toBe(fixtureDir);
  });

  it("uses AETHER_LINK_POC_PATH to keep E2E fixtures independent from the repo layout", () => {
    const pocPath = path.resolve("C:/tmp/aether-link-poc.exe");

    expect(
      resolveAgentPocPath(
        {
          AETHER_LINK_POC_PATH: pocPath,
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
      expect(resolved).toBe(path.resolve("C:/tmp/packaged-agent/bin/aether-link-poc.exe"));
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
      expect(resolved).toBe(path.resolve("C:/tmp/resources/bin/aether-link-poc.exe"));
    } finally {
      spy.mockRestore();
    }
  });
});
