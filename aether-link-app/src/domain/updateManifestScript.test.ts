import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..", "..");
const manifestScript = path.join(projectRoot, "scripts", "create-update-manifest.js");

function fixtureFiles(root: string) {
  const files = {
    viewerX64: path.join(root, "WonRemote-Viewer-Setup.exe"),
    viewerX86: path.join(root, "WonRemote-Viewer-Setup-x86.exe"),
    agentX64: path.join(root, "WonRemote-Agent-Setup.exe"),
    agentX86: path.join(root, "WonRemote-Agent-Setup-x86.exe"),
  };
  for (const [name, file] of Object.entries(files)) {
    writeFileSync(file, `${name}-bytes`);
  }
  return files;
}

describe("production update manifest scripts", () => {
  it("creates viewerWindows, agentWindows, and legacy windows from four signed installers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-manifest-contract-"));
    try {
      const files = fixtureFiles(root);
      const out = path.join(root, "wonremote-update-manifest.json");
      const key = path.join(root, "private.pem");
      const publicKey = path.join(root, "public.pem");
      execFileSync(process.execPath, [path.join(projectRoot, "scripts", "generate-update-keypair.js"), `--private-key=${key}`, `--public-key=${publicKey}`], { cwd: projectRoot });
      execFileSync(process.execPath, [
        manifestScript,
        `--viewer-x64=${files.viewerX64}`,
        `--viewer-x86=${files.viewerX86}`,
        `--agent-x64=${files.agentX64}`,
        `--agent-x86=${files.agentX86}`,
        "--version=9.9.9",
        `--private-key=${key}`,
        `--out=${out}`,
      ], { cwd: projectRoot });
      const manifest = JSON.parse(readFileSync(out, "utf8"));
      expect(manifest.viewerWindows.x64.name).toBe("WonRemote-Viewer-Setup.exe");
      expect(manifest.agentWindows.x86.name).toBe("WonRemote-Agent-Setup-x86.exe");
      expect(manifest.windows).toEqual(manifest.viewerWindows);
      expect(manifest.viewerWindows.x64.url).toContain("/download/v9.9.9/");
      expect(manifest.viewerWindows.x64.url).not.toContain("latest/download");
      execFileSync(process.execPath, [
        path.join(projectRoot, "scripts", "verify-release-manifest.js"),
        "--manifest", out,
        "--version", "9.9.9",
        "--viewer-x64", files.viewerX64,
        "--viewer-x86", files.viewerX86,
        "--agent-x64", files.agentX64,
        "--agent-x86", files.agentX86,
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

  it("fails when any of the four installer inputs is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-manifest-missing-"));
    try {
      const files = fixtureFiles(root);
      rmSync(files.agentX86);
      expect(() => execFileSync(process.execPath, [manifestScript, `--viewer-x64=${files.viewerX64}`, `--viewer-x86=${files.viewerX86}`, `--agent-x64=${files.agentX64}`, `--agent-x86=${files.agentX86}`, "--version=9.9.9", `--out=${path.join(root, "out.json")}`], { cwd: projectRoot })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes exactly four installers and one manifest after the draft gate", () => {
    const script = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    expect(script.match(/^Publish-Asset /gm)?.length).toBe(5);
    expect(script).toContain("draft = $true");
    expect(script).toContain("draft = $false");
    expect(script).toContain("Publish-Asset $StableInstallerPath $StableInstallerAssetName");
    expect(script).toContain("Publish-Asset $StableAgentInstallerPathX86 $StableAgentInstallerAssetNameX86");
    expect(script).toContain("Publish-Asset $ManifestPath $ManifestName");
    expect(script).not.toContain("Portable");
    expect(script).not.toContain("_${Version}_");
  });
});
