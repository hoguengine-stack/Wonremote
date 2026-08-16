import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyStableX86Installers } from "./package-release-exes.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("x86 release installers", () => {
  it("copies only the x86 Viewer and Agent installers to stable release names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-x86-release-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    fs.mkdirSync(source);
    const viewerInstallerPath = path.join(source, "viewer-x86.exe");
    const agentInstallerPath = path.join(source, "agent-x86.exe");
    fs.writeFileSync(viewerInstallerPath, "viewer-x86");
    fs.writeFileSync(agentInstallerPath, "agent-x86");

    copyStableX86Installers({ viewerInstallerPath, agentInstallerPath }, output);

    expect(fs.readdirSync(output).sort()).toEqual([
      "WonRemote-Agent-Setup.exe",
      "WonRemote-Viewer-Setup.exe",
    ]);
    expect(fs.readFileSync(path.join(output, "WonRemote-Viewer-Setup.exe"), "utf8")).toBe("viewer-x86");
    expect(fs.readFileSync(path.join(output, "WonRemote-Agent-Setup.exe"), "utf8")).toBe("agent-x86");
  });
});
