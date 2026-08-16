import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstallerUpdateResult } from "./updateResult";

describe("installer update result", () => {
  it("restores a retained rollback result for the first post-update heartbeat", async () => {
    const root = path.join(os.tmpdir(), `wonremote-update-result-${process.pid}-${Date.now()}`);
    const resultPath = path.join(root, "last-update-result.json");
    try {
      await mkdir(root, { recursive: true });
      await writeFile(resultPath, JSON.stringify({ state: "rollback", error: "new runtime failed", targetVersion: "0.1.62", updatedAt: "2026-08-16T00:00:00.000Z" }));
      await expect(loadInstallerUpdateResult(resultPath, "0.1.62")).resolves.toEqual({
        currentVersion: "0.1.62",
        error: "new runtime failed",
        progress: 0,
        state: "rollback",
        targetVersion: "0.1.62",
        updatedAt: "2026-08-16T00:00:00.000Z",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
