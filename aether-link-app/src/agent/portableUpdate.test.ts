import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadPortableUpdate,
  isPortableUpdateMetadata,
  PORTABLE_MARKER_FILENAME,
  preparePortableHandoff,
  readPortablePackageMarker,
} from "./portableUpdate";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(packageKind: "portable" | "portable-agent" = "portable") {
  const root = await mkdtemp(path.join(os.tmpdir(), "wonremote-portable-update-"));
  roots.push(root);
  const portableRoot = path.join(root, "portable");
  await mkdir(portableRoot, { recursive: true });
  await writeFile(path.join(portableRoot, PORTABLE_MARKER_FILENAME), JSON.stringify({
    packageKind,
    schemaVersion: 1,
    version: "0.1.39",
  }));
  return { baseDir: path.join(root, "appdata"), portableRoot };
}

describe("portable release updater", () => {
  it("downloads only HTTPS ZIP metadata whose checksum matches", async () => {
    const { baseDir } = await fixtureRoot();
    const bytes = Buffer.from("signed-portable-archive");
    const result = await downloadPortableUpdate({
      assetName: "../WonRemote-Viewer-Agent-Portable.zip",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      downloadUrl: "https://example.com/WonRemote-Viewer-Agent-Portable.zip",
      forceUpdate: false,
      latestVersion: "0.1.40",
      reloadViewer: false,
      updateKind: "portable",
    }, {
      baseDir,
      fetchImpl: async () => new Response(bytes),
    });

    expect(path.dirname(result.archivePath)).toBe(path.join(baseDir, "WonRemote", "updates"));
    expect(path.basename(result.archivePath)).toMatch(
      /^WonRemote-Viewer-Agent-Portable-[0-9a-f]{8}-[0-9a-f-]{27}\.zip$/,
    );
    expect(await readFile(result.archivePath, "utf8")).toBe(bytes.toString());
  });

  it("rejects mismatched portable checksums and unsafe metadata", async () => {
    const { baseDir } = await fixtureRoot();
    expect(isPortableUpdateMetadata({ updateKind: "installer" })).toBe(false);
    await expect(downloadPortableUpdate({
      assetName: "WonRemote-Agent-Portable.zip",
      checksum: "a".repeat(64),
      downloadUrl: "https://example.com/WonRemote-Agent-Portable.zip",
      forceUpdate: false,
      latestVersion: "0.1.40",
      reloadViewer: false,
      updateKind: "portable-agent",
    }, {
      baseDir,
      fetchImpl: async () => new Response("wrong"),
    })).rejects.toThrow("checksum mismatch");
  });

  it("creates an external handoff with package validation, owned-file replacement, health check, and rollback", async () => {
    const { baseDir, portableRoot } = await fixtureRoot("portable-agent");
    const archivePath = path.join(baseDir, "WonRemote", "updates", "WonRemote-Agent-Portable.zip");
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, "fixture");
    const handoff = await preparePortableHandoff({
      archivePath,
      latestVersion: "0.1.40",
      packageKind: "portable-agent",
    }, {
      baseDir,
      portableRoot,
      restartMode: "agent",
    });
    const script = await readFile(handoff.scriptPath, "utf8");

    expect(handoff.command).toBe("powershell.exe");
    expect(script).toContain("Expand-Archive -LiteralPath");
    expect(script).toContain("Stop-PortableProcesses");
    expect(script).toContain("Remove-OwnedEntries $PortableRoot");
    expect(script).toContain("Updated portable runtime exited during the verification window");
    expect(script).toContain("Previous portable version restored and restarted");
    expect(script).toContain("WonRemote Agent.exe");
    expect(script).toContain("Get-PortableRunState");
    expect(script).toContain("Convert-ExtendedPath");
    expect(script).toContain("$PortableRoot = Convert-ExtendedPath $PortableRoot");
    expect(script).toContain("Another portable update is already in progress");
    expect(script).toContain("[System.IO.FileShare]::None");
    expect(script).toContain("Test-PortableAgentRuntime");
    expect(script).toContain("(?i)[\\\\/]agent[\\\\/]index\\.mjs");
    expect(script).toContain("(?i)(^|\\s)--watch(\\s|$)");
    expect(script).toContain("Portable update could not remove owned entry");
    expect(script).toContain("Start-PortableRuntimes $restartViewer $restartAgent");
    expect(script).toContain("-ArgumentList @('--agent')");
    const secondHandoff = await preparePortableHandoff({
      archivePath,
      latestVersion: "0.1.40",
      packageKind: "portable-agent",
    }, {
      baseDir,
      portableRoot,
      restartMode: "agent",
    });
    expect(secondHandoff.scriptPath).not.toBe(handoff.scriptPath);
    expect(secondHandoff.logPath).not.toBe(handoff.logPath);
  });

  it("requires the current portable marker to match the release product", async () => {
    const { baseDir, portableRoot } = await fixtureRoot("portable");
    expect(await readPortablePackageMarker(portableRoot)).toMatchObject({ packageKind: "portable" });
    await expect(preparePortableHandoff({
      archivePath: path.join(baseDir, "update.zip"),
      latestVersion: "0.1.40",
      packageKind: "portable-agent",
    }, {
      baseDir,
      portableRoot: path.toNamespacedPath(portableRoot),
      restartMode: "agent",
    })).rejects.toThrow("does not match");
  });

  it("migrates pre-marker portable folders by their stable executable layout", async () => {
    const { baseDir, portableRoot } = await fixtureRoot("portable");
    await rm(path.join(portableRoot, PORTABLE_MARKER_FILENAME), { force: true });
    await writeFile(path.join(portableRoot, "WonRemote Agent.exe"), "fixture");
    await writeFile(path.join(portableRoot, "WonRemote Viewer.exe"), "fixture");
    await expect(preparePortableHandoff({
      archivePath: path.join(baseDir, "WonRemote-Viewer-Agent-Portable.zip"),
      latestVersion: "0.1.40",
      packageKind: "portable",
    }, {
      baseDir,
      portableRoot: path.toNamespacedPath(portableRoot),
      restartMode: "viewer",
    })).resolves.toMatchObject({ command: "powershell.exe" });
  });
});
