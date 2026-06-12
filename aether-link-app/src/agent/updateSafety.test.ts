import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSourceTreeUpdateTarget } from "./updateSafety";

describe("agent update safety", () => {
  it("allows source-tree updates only for a complete npm app tree", () => {
    const tempDir = path.join(os.tmpdir(), `wonremote-update-source-${process.pid}-${Date.now()}`);
    mkdirSync(path.join(tempDir, "src"), { recursive: true });
    writeFileSync(path.join(tempDir, "package.json"), "{}");
    writeFileSync(path.join(tempDir, "package-lock.json"), "{}");

    try {
      expect(isSourceTreeUpdateTarget(tempDir)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks source-tree updates for packaged Tauri resource directories", () => {
    const tempDir = path.join(os.tmpdir(), `wonremote-update-packaged-${process.pid}-${Date.now()}`);
    mkdirSync(path.join(tempDir, "agent"), { recursive: true });
    mkdirSync(path.join(tempDir, "server"), { recursive: true });
    writeFileSync(path.join(tempDir, "agent", "index.mjs"), "");

    try {
      expect(isSourceTreeUpdateTarget(tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
