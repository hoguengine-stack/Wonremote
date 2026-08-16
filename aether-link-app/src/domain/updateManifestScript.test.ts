import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..", "..");
const manifestScript = path.join(projectRoot, "scripts", "create-update-manifest.js");

function fixtureFiles(root: string) {
  const files = {
    viewer: path.join(root, "WonRemote-Viewer-Setup.exe"),
    agent: path.join(root, "WonRemote-Agent-Setup.exe"),
  };
  for (const [name, file] of Object.entries(files)) {
    writeFileSync(file, `${name}-bytes`);
  }
  return files;
}

describe("production update manifest scripts", () => {
  it("creates independently signed x64 compatibility and x86 metadata for two x86 installers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-manifest-contract-"));
    try {
      const files = fixtureFiles(root);
      const out = path.join(root, "wonremote-update-manifest.json");
      const key = path.join(root, "private.pem");
      const publicKey = path.join(root, "public.pem");
      execFileSync(process.execPath, [path.join(projectRoot, "scripts", "generate-update-keypair.js"), `--private-key=${key}`, `--public-key=${publicKey}`], { cwd: projectRoot });
      execFileSync(process.execPath, [
        manifestScript,
        `--viewer-x64=${files.viewer}`,
        `--agent-x64=${files.agent}`,
        "--version=9.9.9",
        `--private-key=${key}`,
        `--out=${out}`,
      ], { cwd: projectRoot });
      const manifest = JSON.parse(readFileSync(out, "utf8"));
      expect(manifest.viewerWindows.x64.name).toBe("WonRemote-Viewer-Setup.exe");
      expect(manifest.viewerWindows.x86.name).toBe("WonRemote-Viewer-Setup.exe");
      expect(manifest.agentWindows.x64.name).toBe("WonRemote-Agent-Setup.exe");
      expect(manifest.agentWindows.x86.name).toBe("WonRemote-Agent-Setup.exe");
      expect(manifest.architectureMigration).toBeUndefined();
      expect(manifest.windows).toEqual(manifest.viewerWindows);
      expect(manifest.viewerWindows.x64.url).toContain("/download/v9.9.9/");
      expect(manifest.viewerWindows.x64.url).not.toContain("latest/download");
      execFileSync(process.execPath, [
        path.join(projectRoot, "scripts", "verify-release-manifest.js"),
        "--manifest", out,
        "--version", "9.9.9",
        "--viewer-x64", files.viewer,
        "--agent-x64", files.agent,
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: readFileSync(publicKey, "utf8"),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when either required product installer input is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-manifest-missing-"));
    try {
      const files = fixtureFiles(root);
      rmSync(files.agent);
      expect(() => execFileSync(process.execPath, [manifestScript, `--viewer-x64=${files.viewer}`, `--agent-x64=${files.agent}`, "--version=9.9.9", `--out=${path.join(root, "out.json")}`], { cwd: projectRoot })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes exactly two x86 installers and one manifest after the draft gate", () => {
    const script = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    expect(script.match(/^Publish-Asset /gm)?.length).toBe(3);
    expect(script).toContain("draft = $true");
    expect(script).toContain("draft = $false");
    expect(script).toContain("Publish-Asset $StableInstallerPath $StableInstallerAssetName");
    expect(script).toContain("Publish-Asset $StableAgentInstallerPath $StableAgentInstallerAssetName");
    expect(script).toContain("Publish-Asset $ManifestPath $ManifestName");
    expect(script).not.toContain("Portable");
    expect(script).not.toContain("_${Version}_");
  });
});
