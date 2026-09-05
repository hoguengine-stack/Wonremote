import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildViewerInstaller,
  buildTauriBundleCommand,
  canReuseViewerBinary,
  copyStableX86Installers,
  verifyAgentRuntimeBundle,
  viewerRustInputFingerprint,
} from "./package-release-exes.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("x86 release installers", () => {
  it("reuses a Viewer binary only when its Rust input stamp matches", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-viewer-stamp-"));
    temporaryDirectories.push(root);
    const tauriRoot = path.join(root, "src-tauri");
    fs.mkdirSync(path.join(tauriRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(tauriRoot, "Cargo.toml"), "[package]\nname = 'viewer'\n");
    fs.writeFileSync(path.join(tauriRoot, "src", "lib.rs"), "fn main() {}\n");
    const fingerprint = viewerRustInputFingerprint(root, { rustcIdentity: "rustc test", env: {} });
    const stampPath = path.join(root, "stamp.json");
    const binaryPath = path.join(root, "wonremote-viewer.exe");
    fs.writeFileSync(stampPath, JSON.stringify({ fingerprint }));
    fs.writeFileSync(binaryPath, "viewer");

    expect(canReuseViewerBinary({}, fingerprint, stampPath, binaryPath)).toBe(true);
    fs.writeFileSync(path.join(tauriRoot, "src", "lib.rs"), "fn changed() {}\n");
    expect(canReuseViewerBinary({}, viewerRustInputFingerprint(root, { rustcIdentity: "rustc test", env: {} }), stampPath, binaryPath)).toBe(false);
  });

  it("stages fresh resources before bundling a reused Viewer binary", () => {
    const operations = [];
    let resourceMarker = "stale";
    let bundledMarker;
    buildViewerInstaller({ key: "x86", viewerConfig: "test.json" }, {
      fingerprint: "verified",
      canReuse: () => true,
      buildResources: () => {
        operations.push("build-resources");
        resourceMarker = "fresh";
      },
      cleanResources: () => operations.push("clean-target-resources"),
      bundleViewer: () => {
        operations.push("bundle-viewer");
        bundledMarker = resourceMarker;
      },
    });

    expect(operations).toEqual(["build-resources", "clean-target-resources", "bundle-viewer"]);
    expect(bundledMarker).toBe("fresh");
  });

  it("validates the Agent bundle from the fresh Tauri resource source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-agent-resource-"));
    temporaryDirectories.push(root);
    const agentBundlePath = path.join(root, "dist-agent", "index.mjs");
    fs.mkdirSync(path.dirname(agentBundlePath), { recursive: true });
    fs.writeFileSync(agentBundlePath, "// wonremote-webrtc-runtime:werift\n");

    expect(() => verifyAgentRuntimeBundle({ key: "x86" }, agentBundlePath)).not.toThrow();
  });

  it("packages the Agent from the existing x86 binary without invoking tauri build", () => {
    const command = buildTauriBundleCommand(
      { rustTarget: "i686-pc-windows-msvc" },
      "src-tauri/tauri.agent.x86.conf.json",
    );

    expect(command).toBe(
      "npx tauri bundle --bundles nsis --target i686-pc-windows-msvc --config src-tauri/tauri.agent.x86.conf.json",
    );
    expect(command).not.toContain("tauri build");
  });

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
