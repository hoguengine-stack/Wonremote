import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProductionUpdateManifest } from "./updateManifest";

const projectRoot = path.resolve(__dirname, "..", "..");

describe("production update manifest scripts", () => {
  it("generates a signed manifest that the production parser can verify", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-"));
    const installerPath = path.join(tempDir, "WonRemote Viewer_9.9.9_x64-setup.exe");
    const portablePath = path.join(tempDir, "WonRemote-Viewer-Agent-Portable.zip");
    const portablePathX86 = path.join(tempDir, "WonRemote-Viewer-Agent-Portable-x86.zip");
    const portableAgentPath = path.join(tempDir, "WonRemote-Agent-Portable.zip");
    const portableAgentPathX86 = path.join(tempDir, "WonRemote-Agent-Portable-x86.zip");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");

    writeFileSync(installerPath, "installer-bytes-for-signing");
    writeFileSync(portablePath, "portable-viewer-agent-x64");
    writeFileSync(portablePathX86, "portable-viewer-agent-x86");
    writeFileSync(portableAgentPath, "portable-agent-x64");
    writeFileSync(portableAgentPathX86, "portable-agent-x86");

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
        `--portable-x64=${portablePath}`,
        `--portable-x86=${portablePathX86}`,
        `--portable-agent-x64=${portableAgentPath}`,
        `--portable-agent-x86=${portableAgentPathX86}`,
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
    expect(manifest.portable.x64).toMatchObject({
      name: "WonRemote-Viewer-Agent-Portable.zip",
      url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Portable.zip",
      sha256: createHash("sha256").update("portable-viewer-agent-x64").digest("hex"),
    });
    expect(manifest.portable.x86.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(manifest.portable.x86.signatureV2).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(manifest.portableAgent.x64).toMatchObject({
      name: "WonRemote-Agent-Portable.zip",
      sha256: createHash("sha256").update("portable-agent-x64").digest("hex"),
    });
    expect(manifest.portableAgent.x86.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(manifest.portableAgent.x86.signatureV2).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("uses a stable latest GitHub installer URL when no URL is supplied", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-url-"));
    const installerPath = path.join(tempDir, "WonRemote Viewer_9.9.9_x64-setup.exe");
    const portablePath = path.join(tempDir, "WonRemote-Viewer-Agent-Portable.zip");
    const portablePathX86 = path.join(tempDir, "WonRemote-Viewer-Agent-Portable-x86.zip");
    const portableAgentPath = path.join(tempDir, "WonRemote-Agent-Portable.zip");
    const portableAgentPathX86 = path.join(tempDir, "WonRemote-Agent-Portable-x86.zip");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");

    writeFileSync(installerPath, "installer-bytes-for-github-url");
    writeFileSync(portablePath, "portable-viewer-agent-x64");
    writeFileSync(portablePathX86, "portable-viewer-agent-x86");
    writeFileSync(portableAgentPath, "portable-agent-x64");
    writeFileSync(portableAgentPathX86, "portable-agent-x86");

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
        `--portable-x64=${portablePath}`,
        `--portable-x86=${portablePathX86}`,
        `--portable-agent-x64=${portableAgentPath}`,
        `--portable-agent-x86=${portableAgentPathX86}`,
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
    expect(manifest.portable.x86.url).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Portable-x86.zip",
    );
    expect(manifest.portableAgent.x86.url).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Agent-Portable-x86.zip",
    );
  });

  it("does not reuse an explicit x64 URL for the x86 installer", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-arches-"));
    const installerPath = path.join(tempDir, "WonRemote-Viewer-Agent-Setup.exe");
    const installerPathX86 = path.join(tempDir, "WonRemote-Viewer-Agent-Setup-x86.exe");
    const portablePath = path.join(tempDir, "WonRemote-Viewer-Agent-Portable.zip");
    const portablePathX86 = path.join(tempDir, "WonRemote-Viewer-Agent-Portable-x86.zip");
    const portableAgentPath = path.join(tempDir, "WonRemote-Agent-Portable.zip");
    const portableAgentPathX86 = path.join(tempDir, "WonRemote-Agent-Portable-x86.zip");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");

    writeFileSync(installerPath, "x64-installer");
    writeFileSync(installerPathX86, "x86-installer");
    writeFileSync(portablePath, "portable-viewer-agent-x64");
    writeFileSync(portablePathX86, "portable-viewer-agent-x86");
    writeFileSync(portableAgentPath, "portable-agent-x64");
    writeFileSync(portableAgentPathX86, "portable-agent-x86");
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
        `--portable-x64=${portablePath}`,
        `--portable-x86=${portablePathX86}`,
        `--portable-agent-x64=${portableAgentPath}`,
        `--portable-agent-x86=${portableAgentPathX86}`,
        "--version=9.9.9",
        "--download-url=https://example.com/WonRemote-Viewer-Agent-Setup.exe",
        "--portable-download-url-x64=https://example.com/WonRemote-Viewer-Agent-Portable.zip",
        "--portable-agent-download-url-x64=https://example.com/WonRemote-Agent-Portable.zip",
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
    expect(manifest.portable.x64.url).toBe("https://example.com/WonRemote-Viewer-Agent-Portable.zip");
    expect(manifest.portable.x86.url).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Portable-x86.zip",
    );
    expect(manifest.portable.x86.url).not.toBe(manifest.portable.x64.url);
    expect(manifest.portableAgent.x64.url).toBe("https://example.com/WonRemote-Agent-Portable.zip");
    expect(manifest.portableAgent.x86.url).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Agent-Portable-x86.zip",
    );
    expect(manifest.portableAgent.x86.url).not.toBe(manifest.portableAgent.x64.url);

    const originalManifest = readFileSync(manifestPath, "utf8");
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
      "--portable-x64",
      portablePath,
      "--portable-x86",
      portablePathX86,
      "--portable-agent-x64",
      portableAgentPath,
      "--portable-agent-x86",
      portableAgentPathX86,
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

    const signatureTamperedManifest = JSON.parse(originalManifest);
    signatureTamperedManifest.portable.x64.signature = Buffer.alloc(64).toString("base64");
    writeFileSync(manifestPath, `${JSON.stringify(signatureTamperedManifest, null, 2)}\n`, "utf8");
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
    writeFileSync(manifestPath, originalManifest, "utf8");

    const policyTamperedManifest = JSON.parse(originalManifest);
    policyTamperedManifest.forceUpdate = true;
    writeFileSync(manifestPath, `${JSON.stringify(policyTamperedManifest, null, 2)}\n`, "utf8");
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
    writeFileSync(manifestPath, originalManifest, "utf8");

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

    writeFileSync(installerPathX86, "x86-installer");
    writeFileSync(portableAgentPathX86, "tampered-portable-agent-x86");
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

  it("refuses to create a release manifest when any required portable ZIP is missing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-release-manifest-missing-portable-"));
    const installerPath = path.join(tempDir, "WonRemote-Viewer-Agent-Setup.exe");
    const portablePath = path.join(tempDir, "WonRemote-Viewer-Agent-Portable.zip");
    const portablePathX86 = path.join(tempDir, "WonRemote-Viewer-Agent-Portable-x86.zip");
    const portableAgentPath = path.join(tempDir, "WonRemote-Agent-Portable.zip");
    const missingPortableAgentPathX86 = path.join(tempDir, "WonRemote-Agent-Portable-x86.zip");
    const privateKeyPath = path.join(tempDir, "update-signing-private.pem");
    const publicKeyPath = path.join(tempDir, "update-signing-public.pem");

    writeFileSync(installerPath, "x64-installer");
    writeFileSync(portablePath, "portable-viewer-agent-x64");
    writeFileSync(portablePathX86, "portable-viewer-agent-x86");
    writeFileSync(portableAgentPath, "portable-agent-x64");
    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "generate-update-keypair.js"),
        `--private-key=${privateKeyPath}`,
        `--public-key=${publicKeyPath}`,
      ],
      { cwd: projectRoot, stdio: "pipe", windowsHide: true },
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          path.join(projectRoot, "scripts", "create-update-manifest.js"),
          `--installer=${installerPath}`,
          `--portable-x64=${portablePath}`,
          `--portable-x86=${portablePathX86}`,
          `--portable-agent-x64=${portableAgentPath}`,
          `--portable-agent-x86=${missingPortableAgentPathX86}`,
          `--private-key=${privateKeyPath}`,
        ],
        { cwd: projectRoot, stdio: "pipe", windowsHide: true },
      ),
    ).toThrow();
  });

  it("publishes GitHub release assets atomically behind a draft gate", () => {
    const publishScript = readFileSync(
      path.join(projectRoot, "scripts", "publish-github-release.ps1"),
      "utf8",
    );
    const createRelease = publishScript.indexOf('$Release = Invoke-GitHubJson "Post"');
    const uploadPortable = publishScript.indexOf("Publish-Asset $PortableZipPath $PortableZipName");
    const uploadPortableX86 = publishScript.indexOf("Publish-Asset $PortableZipPathX86 $PortableZipNameX86");
    const uploadPortableAgent = publishScript.indexOf("Publish-Asset $AgentZipPath $AgentZipName");
    const uploadPortableAgentX86 = publishScript.indexOf("Publish-Asset $AgentZipPathX86 $AgentZipNameX86");
    const uploadManifest = publishScript.indexOf("Publish-Asset $ManifestPath $ManifestName");
    const publishRelease = publishScript.lastIndexOf('$Release = Invoke-GitHubJson "Patch"');

    expect(publishScript).toContain("draft = $true");
    expect(publishScript).toContain("if (-not $RequestedDraft)");
    expect(publishScript).toContain("draft = $false");
    expect(createRelease).toBeGreaterThan(-1);
    expect(publishScript).toContain("--portable-agent-x86 $AgentZipPathX86");
    expect(uploadPortable).toBeGreaterThan(createRelease);
    expect(uploadPortableX86).toBeGreaterThan(createRelease);
    expect(uploadPortableAgent).toBeGreaterThan(createRelease);
    expect(uploadPortableAgentX86).toBeGreaterThan(createRelease);
    expect(uploadManifest).toBeGreaterThan(uploadPortable);
    expect(uploadManifest).toBeGreaterThan(uploadPortableX86);
    expect(uploadManifest).toBeGreaterThan(uploadPortableAgent);
    expect(uploadManifest).toBeGreaterThan(uploadPortableAgentX86);
    expect(uploadManifest).toBeGreaterThan(createRelease);
    expect(publishRelease).toBeGreaterThan(uploadManifest);
  });

  it("packages a product-specific portable marker without leaking it into installed resources", () => {
    const packageScriptPath = path.join(projectRoot, "scripts", "package-release-exes.js");
    const packageScript = readFileSync(packageScriptPath, "utf8");
    const tempDir = mkdtempSync(path.join(tmpdir(), "wonremote-portable-marker-"));
    const combinedMarker = packageScript.indexOf('withPortableMarker(target, "portable"');
    const agentMarker = packageScript.indexOf('withPortableMarker(target, "portable-agent"');
    const installerBuild = packageScript.lastIndexOf("createCombinedInstaller(");
    const portableBuild = packageScript.lastIndexOf("createPortableZip(target)");
    const markerWrite = packageScript.indexOf("fs.writeFileSync(markerPath");

    expect(packageScript).toContain('const portableMarkerName = "wonremote-portable.json"');
    expect(packageScript.match(/portableMarkerName,/g)).toHaveLength(2);
    expect(packageScript).toContain("schemaVersion: 1");
    expect(packageScript).toContain("packageKind,");
    expect(packageScript).toContain("version: packageJson.version");
    expect(packageScript).not.toContain("architecture: target.key");
    expect(packageScript).toContain("fs.rmSync(markerPath, { force: true })");
    expect(packageScript).toContain("Portable marker must not be present in installed");
    expect(packageScript).toContain("Portable marker cleanup failed");
    expect(combinedMarker).toBeGreaterThan(-1);
    expect(agentMarker).toBeGreaterThan(combinedMarker);
    expect(markerWrite).toBeGreaterThan(-1);
    expect(installerBuild).toBeGreaterThan(-1);
    expect(portableBuild).toBeLessThan(installerBuild);
    expect(packageScript).toContain('File /oname=portable-installer-bridge.ps1');
    expect(packageScript).toContain('ReadEnvStr $R0 "WONREMOTE_APP_DIR"');
    expect(packageScript).toContain('-CombinedArchivePath \\"$PLUGINSDIR');
    expect(packageScript).toContain('-AgentArchivePath \\"$PLUGINSDIR');
    expect(packageScript).toContain('$R4 != 10');

    const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;
    const verificationScript = `
      import fs from "node:fs";
      const { withPortableMarker } = await import(${JSON.stringify(pathToFileURL(packageScriptPath).href)});
      const target = { stageDir: ${JSON.stringify(tempDir)} };
      for (const packageKind of ["portable", "portable-agent"]) {
        withPortableMarker(target, packageKind, () => {
          const marker = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(tempDir, "wonremote-portable.json"))}, "utf8"));
          const expected = { schemaVersion: 1, packageKind, version: ${JSON.stringify(packageVersion)} };
          if (JSON.stringify(marker) !== JSON.stringify(expected)) {
            throw new Error(\`Unexpected marker: \${JSON.stringify(marker)}\`);
          }
        });
        if (fs.existsSync(${JSON.stringify(path.join(tempDir, "wonremote-portable.json"))})) {
          throw new Error(\`Portable marker was not cleaned after \${packageKind}.\`);
        }
      }
    `;
    execFileSync(process.execPath, ["--input-type=module", "--eval", verificationScript], {
      cwd: projectRoot,
      stdio: "pipe",
      windowsHide: true,
    });
    expect(existsSync(path.join(tempDir, "wonremote-portable.json"))).toBe(false);
  });

  it("keeps the legacy portable installer bridge compatible with Windows PowerShell 5.1", () => {
    const bridgePath = path.join(projectRoot, "scripts", "portable-installer-bridge.ps1");
    const bridgeScript = readFileSync(bridgePath, "utf8");

    expect(bridgeScript).not.toContain("??");
    expect(bridgeScript).toContain('[ValidateSet("agent", "viewer", "auto")]');
    expect(bridgeScript).toContain('run-installer-update.ps1');
    expect(bridgeScript).toContain('$restartAgent = $true');
    expect(bridgeScript).toContain('[System.IO.FileShare]::None');
    expect(bridgeScript).toContain('Test-PortableAgentRuntime');
    expect(bridgeScript).toContain('Portable bridge could not remove owned entry');
    expect(() =>
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[void][scriptblock]::Create((Get-Content -LiteralPath '${bridgePath.replace(/'/g, "''")}' -Raw))`,
        ],
        { cwd: projectRoot, stdio: "pipe", windowsHide: true },
      ),
    ).not.toThrow();

    const installedFixtureRoot = mkdtempSync(path.join(tmpdir(), "wonremote-installed-fallback-"));
    const installedRoot = path.join(installedFixtureRoot, "resources");
    mkdirSync(installedRoot, { recursive: true });
    writeFileSync(path.join(installedRoot, "wonremote-viewer.exe"), "installed-layout-sentinel");
    const fallback = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        bridgePath,
        "-PortableRoot",
        path.toNamespacedPath(installedRoot),
        "-CombinedArchivePath",
        path.join(installedRoot, "combined.zip"),
        "-AgentArchivePath",
        path.join(installedRoot, "agent.zip"),
        "-ExpectedVersion",
        "9.9.9",
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, APPDATA: path.dirname(installedRoot) },
        windowsHide: true,
      },
    );
    rmSync(installedFixtureRoot, { force: true, recursive: true });
    expect(fallback.status, fallback.stderr.toString()).toBe(10);
  });
});
