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
      assetName: "WonRemote.Viewer_9.9.9_x64-setup.exe",
      latestVersion: "9.9.9",
      updateKind: "installer",
    });
    expect(metadata.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("uses a stable latest GitHub installer URL when no URL is supplied", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-url-"));
    const installerPath = path.join(tempDir, "WonRemote Viewer_9.9.9_x64-setup.exe");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");

    writeFileSync(installerPath, "installer-bytes-for-github-url");

    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "generate-update-keypair.js"),
        `--private-key=${privateKeyPath}`,
        `--public-key=${publicKeyPath}`,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );

    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "create-update-manifest.js"),
        `--installer=${installerPath}`,
        "--version=9.9.9",
        `--private-key=${privateKeyPath}`,
        `--out=${manifestPath}`,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const publicKeyPem = readFileSync(publicKeyPath, "utf8");
    const metadata = parseProductionUpdateManifest(manifest, { publicKeyPem });

    expect(metadata.assetName).toBe("WonRemote-Viewer-Agent-Setup.exe");
    expect(metadata.downloadUrl).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Setup.exe",
    );
  });

  it("does not reuse an explicit x64 URL for the x86 installer", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-arches-"));
    const installerPath = path.join(tempDir, "WonRemote-Viewer-Agent-Setup.exe");
    const installerPathX86 = path.join(tempDir, "WonRemote-Viewer-Agent-Setup-x86.exe");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");

    writeFileSync(installerPath, "x64-installer");
    writeFileSync(installerPathX86, "x86-installer");
    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "generate-update-keypair.js"),
        `--private-key=${privateKeyPath}`,
        `--public-key=${publicKeyPath}`,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );
    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "create-update-manifest.js"),
        `--installer=${installerPath}`,
        `--installer-x86=${installerPathX86}`,
        "--version=9.9.9",
        "--download-url=https://example.com/WonRemote-Viewer-Agent-Setup.exe",
        `--private-key=${privateKeyPath}`,
        `--out=${manifestPath}`,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.windows.x64.url).toBe("https://example.com/WonRemote-Viewer-Agent-Setup.exe");
    expect(manifest.windows.x86.url).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Setup-x86.exe",
    );
    expect(manifest.windows.x86.url).not.toBe(manifest.windows.x64.url);

    const verifyArgs = [
      path.join(projectRoot, "scripts", "verify-release-manifest.js"),
      "--manifest",
      manifestPath,
      "--version",
      "9.9.9",
      "--installer-x64",
      installerPath,
      "--installer-x86",
      installerPathX86,
    ];
    expect(() =>
      execFileSync(process.execPath, verifyArgs, {
        cwd: projectRoot,
        env: {
          ...process.env,
          WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: readFileSync(publicKeyPath, "utf8"),
        },
        stdio: "pipe",
        windowsHide: true,
      }),
    ).not.toThrow();

    writeFileSync(installerPathX86, "tampered-x86-installer");
    expect(() =>
      execFileSync(process.execPath, verifyArgs, {
        cwd: projectRoot,
        env: {
          ...process.env,
          WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: readFileSync(publicKeyPath, "utf8"),
        },
        stdio: "pipe",
        windowsHide: true,
      }),
    ).toThrow();
  });

  it("publishes GitHub release assets atomically behind a draft gate", () => {
    const publishScript = readFileSync(
      path.join(projectRoot, "scripts", "publish-github-release.ps1"),
      "utf8",
    );
    const createRelease = publishScript.indexOf('$Release = Invoke-GitHubJson "Post"');
    const uploadManifest = publishScript.indexOf("Publish-Asset $ManifestPath $ManifestName");
    const publishRelease = publishScript.lastIndexOf('$Release = Invoke-GitHubJson "Patch"');

    expect(publishScript).toContain("draft = $true");
    expect(publishScript).toContain("if (-not $RequestedDraft)");
    expect(publishScript).toContain("draft = $false");
    expect(createRelease).toBeGreaterThan(-1);
    expect(uploadManifest).toBeGreaterThan(createRelease);
    expect(publishRelease).toBeGreaterThan(uploadManifest);
  });
});
