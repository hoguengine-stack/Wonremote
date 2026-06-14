import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProductionUpdateManifest } from "./updateManifest";

const projectRoot = path.resolve(__dirname, "..", "..");

describe("production update manifest scripts", () => {
  it("generates a signed manifest that the production parser can verify", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-"));
    const installerPath = path.join(tempDir, "WonRemote Viewer_9.9.9_x64-setup.exe");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");

    writeFileSync(installerPath, "installer-bytes-for-signing");

    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "generate-update-keypair.js"),
        "--private-key",
        privateKeyPath,
        "--public-key",
        publicKeyPath,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );

    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "create-update-manifest.js"),
        `--installer=${installerPath}`,
        "--version=9.9.9",
        "--download-url=https://github.com/hoguengine-stack/Wonremote/releases/download/v9.9.9/WonRemote%20Viewer_9.9.9_x64-setup.exe",
        `--private-key=${privateKeyPath}`,
        `--out=${manifestPath}`,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const publicKeyPem = readFileSync(publicKeyPath, "utf8");
    const metadata = parseProductionUpdateManifest(manifest, { publicKeyPem });

    expect(metadata).toMatchObject({
      assetName: "WonRemote Viewer_9.9.9_x64-setup.exe",
      latestVersion: "9.9.9",
      updateKind: "installer",
    });
    expect(metadata.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
