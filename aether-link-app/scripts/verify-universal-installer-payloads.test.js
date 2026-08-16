import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUniversalPayloadVerificationPlan,
  peMachineForBuffer,
  verifyUniversalInstallerPayloads,
} from "./verify-universal-installer-payloads.js";
import { createUniversalProductInstallerScript } from "./package-release-exes.js";

const temporaryRoots = [];

function createFixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-universal-payload-test-"));
  temporaryRoots.push(appRoot);
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const releaseDir = path.join(appRoot, "release-exe");
  fs.mkdirSync(releaseDir, { recursive: true });

  for (const [directory, architecture] of [["release", "x64"], [path.join("i686-pc-windows-msvc", "release"), "x86"]]) {
    const installerDir = path.join(appRoot, "src-tauri", "target", directory, "bundle", "nsis");
    fs.mkdirSync(installerDir, { recursive: true });
    fs.writeFileSync(path.join(installerDir, `WonRemote Viewer_9.9.9_${architecture}-setup.exe`), `viewer-${architecture}`);
    fs.writeFileSync(path.join(installerDir, `WonRemote Agent_9.9.9_${architecture}-setup.exe`), `agent-${architecture}`);
    fs.writeFileSync(
      path.join(appRoot, "src-tauri", "target", directory, "wonremote-viewer.exe"),
      createPeFixture(architecture === "x64" ? 0x8664 : 0x014c),
    );
  }
  return { appRoot, releaseDir };
}

function createPeFixture(machine) {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(128, 0x3c);
  buffer.write("PE\0\0", 128, "binary");
  buffer.writeUInt16LE(machine, 132);
  return buffer;
}

function fakeCompiler(scriptPath) {
  const script = fs.readFileSync(scriptPath, "utf8");
  const outputPath = script.match(/^OutFile "(.+)"$/m)?.[1];
  if (!outputPath) {
    throw new Error("fixture compiler could not resolve OutFile");
  }
  fs.writeFileSync(outputPath.replace(/\\\\/g, "\\"), Buffer.from(script.replace(/^OutFile ".+"$/m, 'OutFile "<normalized>"')));
}

function fakeHostExtractor(installerPath, outputPath) {
  const architecture = installerPath.includes("_x64-") ? "x64" : "x86";
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, createPeFixture(architecture === "x64" ? 0x8664 : 0x014c));
}

function createReleasedWrappers({ appRoot, releaseDir }) {
  const plans = createUniversalPayloadVerificationPlan({ appRoot, releaseDir });
  for (const plan of plans) {
    const scriptPath = path.join(appRoot, `${plan.product}.nsi`);
    const script = createUniversalProductInstallerScript(
      plan.packagePaths,
      plan.product,
      plan.actualInstallerPath,
    );
    fs.writeFileSync(scriptPath, script);
    fakeCompiler(scriptPath);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("universal installer payload verifier", () => {
  it("reads the Tauri host PE machine used to reject mislabeled architecture inputs", () => {
    expect(peMachineForBuffer(createPeFixture(0x8664))).toBe(0x8664);
    expect(peMachineForBuffer(createPeFixture(0x014c))).toBe(0x014c);
    expect(() => peMachineForBuffer(Buffer.from("not-pe"))).toThrow("valid PE executable");
  });

  it("plans both architectures for each product wrapper", () => {
    const fixture = createFixture();
    const plans = createUniversalPayloadVerificationPlan(fixture);

    expect(plans).toHaveLength(2);
    expect(plans[0].packagePaths.x64.viewerInstallerPath).toContain("Viewer_9.9.9_x64-setup.exe");
    expect(plans[0].packagePaths.x86.agentInstallerPath).toContain("Agent_9.9.9_x86-setup.exe");
  });

  it("accepts only released wrappers reproduced from the exact x64 and x86 inner installer set", async () => {
    const fixture = createFixture();
    createReleasedWrappers(fixture);

    const results = await verifyUniversalInstallerPayloads({
      ...fixture,
      compileNsis: fakeCompiler,
      extractHostExecutable: fakeHostExtractor,
    });

    expect(results.map((result) => result.product)).toEqual(["viewer", "agent"]);
    expect(results[0].sourceInnerInstallers.viewer.x64).toMatch(/^[a-f0-9]{64}$/);
    expect(results[0].sourceHostMachines).toEqual({ x64: 0x8664, x86: 0x014c });
  });

  it("rejects a released wrapper whose embedded payload set differs from the current inner installers", async () => {
    const fixture = createFixture();
    createReleasedWrappers(fixture);
    fs.appendFileSync(path.join(fixture.releaseDir, "WonRemote-Agent-Setup.exe"), "tampered");

    await expect(verifyUniversalInstallerPayloads({
      ...fixture,
      compileNsis: fakeCompiler,
      extractHostExecutable: fakeHostExtractor,
    })).rejects.toThrow("Released agent installer does not match");
  });

  it("rejects an inner installer whose extracted host architecture is mislabeled", async () => {
    const fixture = createFixture();
    createReleasedWrappers(fixture);
    const wrongExtractor = (_installerPath, outputPath) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, createPeFixture(0x014c));
    };

    await expect(verifyUniversalInstallerPayloads({
      ...fixture,
      compileNsis: fakeCompiler,
      extractHostExecutable: wrongExtractor,
    })).rejects.toThrow("x64 viewer inner installer PE machine mismatch");
  });
});
