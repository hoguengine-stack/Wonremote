import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createBuildCommands,
  createSpawnInvocation,
  resolveBuildStage,
  resolvePackageExecutable,
  runBuild,
  runCommand,
  validateReuseArtifacts,
} from "./build-app.js";

describe("build app stage runner", () => {
  it("defaults to the full build stage", () => {
    expect(resolveBuildStage(undefined)).toBe("full");
    expect(resolveBuildStage("  ")).toBe("full");
  });

  it("accepts only the supported explicit stages", () => {
    expect(resolveBuildStage("frontend-only")).toBe("frontend-only");
    expect(resolveBuildStage("backend-only")).toBe("backend-only");
    expect(resolveBuildStage("reuse")).toBe("reuse");
    expect(() => resolveBuildStage("frontend")).toThrow(
      "Unsupported WONREMOTE_BUILD_STAGE",
    );
  });

  it("keeps the default build command order", () => {
    expect(createBuildCommands({
      platform: "win32",
      stage: "full",
      nodeExecutable: "C:\\node\\node.exe",
    })).toEqual([
      { command: "npx.cmd", args: ["tsc"] },
      { command: "npx.cmd", args: ["vite", "build"] },
      { command: "C:\\node\\node.exe", args: ["scripts/build-backend.js"] },
      { command: "npm.cmd", args: ["run", "agent:package"] },
    ]);
  });

  it("selects frontend-only and backend-only command groups", () => {
    expect(createBuildCommands({
      platform: "linux",
      stage: "frontend-only",
      nodeExecutable: "/usr/bin/node",
    })).toEqual([
      { command: "npx", args: ["tsc"] },
      { command: "npx", args: ["vite", "build"] },
    ]);
    expect(createBuildCommands({
      platform: "linux",
      stage: "backend-only",
      nodeExecutable: "/usr/bin/node",
    })).toEqual([
      { command: "/usr/bin/node", args: ["scripts/build-backend.js"] },
      { command: "npm", args: ["run", "agent:package"] },
    ]);
    expect(createBuildCommands({ stage: "reuse" })).toEqual([]);
  });

  it("resolves npm and npx to cmd shims only on Windows", () => {
    expect(resolvePackageExecutable("npx", "win32")).toBe("npx.cmd");
    expect(resolvePackageExecutable("npm", "win32")).toBe("npm.cmd");
    expect(resolvePackageExecutable("npx", "linux")).toBe("npx");
    expect(resolvePackageExecutable("npm", "darwin")).toBe("npm");
  });

  it("runs argv directly without a shell", () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null }));

    runCommand(
      { command: "npx.cmd", args: ["vite", "build"] },
      {
        cwd: "C:\\app",
        env: { TEST: "1" },
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        spawn,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "npx.cmd", "vite", "build"],
      {
        cwd: "C:\\app",
        env: { TEST: "1" },
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
  });

  it("does not wrap package executables on non-Windows platforms", () => {
    expect(createSpawnInvocation(
      { command: "npx", args: ["tsc"] },
      { platform: "linux" },
    )).toEqual({ command: "npx", args: ["tsc"] });
  });

  it("fails reuse when any required artifact is missing", () => {
    const rootDir = path.resolve("C:\\app");
    const missingPath = path.join(rootDir, "dist-agent", "index.mjs");

    expect(() => validateReuseArtifacts({
      rootDir,
      exists: (candidate) => candidate !== missingPath,
    })).toThrow(`Reuse build artifacts are missing:\n- ${missingPath}`);
  });

  it("accepts reuse when every required artifact exists", () => {
    expect(validateReuseArtifacts({
      rootDir: "C:\\app",
      exists: () => true,
    })).toBeUndefined();
  });

  it("validates and reuses existing resources without starting a command", () => {
    const spawn = vi.fn();

    expect(runBuild({
      env: { WONREMOTE_BUILD_STAGE: "reuse" },
      exists: () => true,
      spawn,
    })).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});
