import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
