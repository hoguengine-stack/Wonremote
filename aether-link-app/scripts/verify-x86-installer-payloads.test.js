import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createX86PayloadVerificationPlan,
  peMachineForBuffer,
  verifyX86InstallerPayloads,
} from "./verify-x86-installer-payloads.js";

const temporaryRoots = [];

function createPeFixture(machine, body = "") {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(128, 0x3c);
  buffer.write("PE\0\0", 128, "binary");
  buffer.writeUInt16LE(machine, 132);
  Buffer.from(body).copy(buffer, 160);
  return buffer;
}

function createFixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-x86-payload-test-"));
  temporaryRoots.push(appRoot);
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));

  const releaseDir = path.join(appRoot, "release-exe");
  const x86InstallerDir = path.join(
    appRoot,
    "src-tauri",
    "target",
    "i686-pc-windows-msvc",
    "release",
    "bundle",
    "nsis",
  );
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(x86InstallerDir, { recursive: true });

  for (const product of ["Viewer", "Agent"]) {
    const fixture = createPeFixture(0x014c, product);
    fs.writeFileSync(path.join(x86InstallerDir, `WonRemote ${product}_9.9.9_x86-setup.exe`), fixture);
    fs.writeFileSync(path.join(releaseDir, `WonRemote-${product}-Setup.exe`), fixture);
  }

  return { appRoot, releaseDir };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("x86 installer payload verifier", () => {
  it("reads the PE machine used to require x86 release outputs", () => {
    expect(peMachineForBuffer(createPeFixture(0x014c))).toBe(0x014c);
    expect(peMachineForBuffer(createPeFixture(0x8664))).toBe(0x8664);
    expect(() => peMachineForBuffer(Buffer.from("not-pe"))).toThrow("valid PE executable");
  });

  it("plans only the current version x86 Viewer and Agent installers", () => {
    const fixture = createFixture();
    const plans = createX86PayloadVerificationPlan(fixture);

    expect(plans).toHaveLength(2);
    expect(plans[0].x86InstallerPath).toContain("i686-pc-windows-msvc");
    expect(plans[0].x86InstallerPath).toContain("Viewer_9.9.9_x86-setup.exe");
    expect(plans[1].x86InstallerPath).toContain("Agent_9.9.9_x86-setup.exe");
  });

  it("accepts only stable release files identical to the x86 build outputs", async () => {
    const fixture = createFixture();
    const results = await verifyX86InstallerPayloads(fixture);

    expect(results.map((result) => result.product)).toEqual(["viewer", "agent"]);
    expect(results.every((result) => result.peMachine === 0x014c)).toBe(true);
    expect(results.every((result) => /^[a-f0-9]{64}$/.test(result.sha256))).toBe(true);
  });

  it("rejects a stable file whose bytes differ from the x86 build output", async () => {
    const fixture = createFixture();
    fs.appendFileSync(path.join(fixture.releaseDir, "WonRemote-Agent-Setup.exe"), "tampered");

    await expect(verifyX86InstallerPayloads(fixture)).rejects.toThrow(
      "released agent installer does not match the current x86 build output",
    );
  });

  it("rejects a mislabeled non-x86 build output", async () => {
    const fixture = createFixture();
    const source = path.join(
      fixture.appRoot,
      "src-tauri",
      "target",
      "i686-pc-windows-msvc",
      "release",
      "bundle",
      "nsis",
      "WonRemote Viewer_9.9.9_x86-setup.exe",
    );
    fs.writeFileSync(source, createPeFixture(0x8664));

    await expect(verifyX86InstallerPayloads(fixture)).rejects.toThrow(
      "x86 viewer installer PE machine mismatch",
    );
  });
});
