import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runUpdateOnce } from "../../src/agent/agentUpdateOnce";
import {
  downloadInstallerUpdate,
  prepareInstallerHandoff,
  type InstallerHandoffResult,
} from "../../src/agent/productionInstallerUpdate";

type Scenario = "success" | "installer-failure" | "health-failure" | "backup-unavailable";

const OLD_VERSION = "0.1.60";
const NEW_VERSION = "0.1.64";

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("Installer update E2E skipped: Windows is required.");
    return;
  }

  await runScenario("success");
  await runScenario("installer-failure");
  await runScenario("health-failure");
  await runScenario("backup-unavailable");
  console.log("Installer update E2E passed: upgrade, two rollback paths, and backup-required gate.");
}

async function runScenario(scenario: Scenario): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `wonremote-installer-e2e-${scenario}-`));
  const baseDir = path.join(root, "roaming");
  const localAppData = path.join(root, "local");
  const installRoot = path.join(localAppData, "WonRemote", "Viewer");
  const viewerPath = path.join(installRoot, "wonremote-viewer.exe");
  const versionPath = path.join(installRoot, "version.txt");
  let handoff: InstallerHandoffResult | undefined;

  try {
    if (scenario !== "backup-unavailable") {
      await mkdir(installRoot, { recursive: true });
      await compileSleepingViewer(viewerPath);
      await writeFile(versionPath, OLD_VERSION, "utf8");
    }

    const systemPowerShell = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const installerBytes = await readFile(systemPowerShell);
    const checksum = createHash("sha256").update(installerBytes).digest("hex");
    const installerCommand = buildInstallerCommand(scenario, versionPath, viewerPath);
    const metadata = {
      assetName: "WonRemote-Viewer-Setup.exe",
      checksum,
      downloadUrl: "https://updates.invalid/WonRemote-Viewer-Setup.exe",
      forceUpdate: false,
      installerArgs: ["-NoProfile", "-EncodedCommand", encodePowerShell(installerCommand)],
      latestVersion: NEW_VERSION,
      updateKind: "installer" as const,
    };

    const result = await runUpdateOnce(
      { baseDir, restartExecutablePath: viewerPath, restartMode: "viewer" },
      {
        currentVersion: OLD_VERSION,
        downloadInstaller: (value, options) => downloadInstallerUpdate(value, {
          ...options,
          fetchImpl: async () => new Response(installerBytes, { status: 200 }),
        }),
        downloadPortable: async () => { throw new Error("portable path must not be used"); },
        launchHandoff: (value) => { handoff = value as InstallerHandoffResult; },
        loadMetadata: async () => metadata,
        prepareHandoff: prepareInstallerHandoff,
        preparePortableHandoff: async () => { throw new Error("portable path must not be used"); },
      },
    );

    assert.equal(result.status, "handoff-started");
    assert.equal(result.latestVersion, NEW_VERSION);
    assert.ok(handoff, "update handoff was not created");

    const execution = await executeHandoff(handoff, { APPDATA: baseDir, LOCALAPPDATA: localAppData });
    const expectedExit = scenario === "success" ? 0 : scenario === "installer-failure" ? 7 : 1;
    assert.equal(execution.exitCode, expectedExit, execution.stderr);

    const handoffLog = await readFile(handoff.logPath, "utf8");
    if (scenario === "backup-unavailable") {
      await assert.rejects(readFile(versionPath, "utf8"));
      assert.match(handoffLog, /no complete rollback backup was available/);
    } else {
      const expectedVersion = scenario === "success" ? NEW_VERSION : OLD_VERSION;
      assert.equal((await readFile(versionPath, "utf8")).trim(), expectedVersion);
    }
    if (scenario === "success") {
      assert.match(handoffLog, /WonRemote Viewer process health check passed/);
      assert.doesNotMatch(handoffLog, /Restored WonRemote install root/);
    } else if (scenario !== "backup-unavailable") {
      assert.match(handoffLog, /Restored WonRemote install root/);
      assert.match(handoffLog, /rollback completed and previous runtime recovered/);
    }
    const updateEntries = await readdir(path.dirname(handoff.scriptPath));
    assert.equal(updateEntries.some((entry) => entry.startsWith("rollback-")), false);
  } finally {
    await stopFixtureViewer(installRoot);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function buildInstallerCommand(scenario: Scenario, versionPath: string, viewerPath: string): string {
  const version = scenario === "success" ? NEW_VERSION : "broken-version";
  const statements = [`Set-Content -LiteralPath '${escapePowerShell(versionPath)}' -Value '${version}' -Encoding UTF8`];
  if (scenario === "health-failure") {
    statements.push(`Remove-Item -LiteralPath '${escapePowerShell(viewerPath)}' -Force`);
  }
  statements.push(`exit ${scenario === "installer-failure" ? 7 : 0}`);
  return statements.join("; ");
}

async function compileSleepingViewer(outputPath: string): Promise<void> {
  const source = [
    "using System;",
    "using System.Diagnostics;",
    "using System.IO;",
    "using System.Threading;",
    "public static class Program {",
    "  [STAThread] public static void Main() {",
    "    File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, \"fixture.pid\"), Process.GetCurrentProcess().Id.ToString());",
    "    Thread.Sleep(60000);",
    "  }",
    "}",
  ].join(" ");
  const command = `Add-Type -TypeDefinition '${escapePowerShell(source)}' -OutputAssembly '${escapePowerShell(outputPath)}' -OutputType WindowsApplication`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodePowerShell(command)], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function executeHandoff(
  handoff: InstallerHandoffResult,
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(handoff.command, handoff.args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}

async function stopFixtureViewer(installRoot: string): Promise<void> {
  const pidPath = path.join(installRoot, "fixture.pid");
  try {
    const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch { /* process already stopped */ }
    }
  } catch {
    // No fixture process reached the running state.
  }
}

function encodePowerShell(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
