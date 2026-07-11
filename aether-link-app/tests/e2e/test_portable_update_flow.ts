import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  downloadPortableUpdate,
  PORTABLE_MARKER_FILENAME,
  preparePortableHandoff,
} from "../../src/agent/portableUpdate";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(import.meta.dirname, "..", "..");
const currentVersion = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")).version as string;

const scenarios = [
  {
    executableName: "WonRemote Viewer.exe",
    label: "x64 combined",
    newArchive: path.join(appRoot, "release-exe", "WonRemote-Viewer-Agent-Portable.zip"),
    oldArchive: path.join(os.tmpdir(), "wonremote-portable-update-e2e", "old-combined-x64.zip"),
    packageKind: "portable" as const,
    restartMode: "viewer" as const,
  },
  {
    executableName: "WonRemote Agent.exe",
    label: "x86 Agent-only",
    newArchive: path.join(appRoot, "release-exe", "WonRemote-Agent-Portable-x86.zip"),
    oldArchive: path.join(os.tmpdir(), "wonremote-portable-update-e2e", "old-agent-x86.zip"),
    packageKind: "portable-agent" as const,
    restartMode: "agent" as const,
  },
];

async function main() {
  for (const scenario of scenarios) {
    await runScenario(scenario);
  }
  await runLockContentionScenario();
  await runRollbackScenario();
  await runAgentChildRollbackScenario();
}

async function runLockContentionScenario() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wonremote-portable-lock-"));
  const portableRoot = path.join(fixtureRoot, "portable");
  const appDataRoot = path.join(fixtureRoot, "appdata");
  let lockHolder: ReturnType<typeof spawn> | null = null;
  try {
    await expandArchive(scenarios[0].oldArchive, portableRoot);
    const oldViewerHash = await sha256File(path.join(portableRoot, "WonRemote Viewer.exe"));
    const archiveBytes = await readFile(scenarios[0].newArchive);
    const download = await downloadPortableUpdate({
      assetName: "WonRemote-Viewer-Agent-Portable.zip",
      checksum: createHash("sha256").update(archiveBytes).digest("hex"),
      downloadUrl: "https://fixture.invalid/WonRemote-Viewer-Agent-Portable.zip",
      forceUpdate: false,
      latestVersion: currentVersion,
      reloadViewer: false,
      updateKind: "portable",
    }, {
      baseDir: appDataRoot,
      fetchImpl: async () => new Response(archiveBytes),
    });
    const handoff = await preparePortableHandoff(download, {
      baseDir: appDataRoot,
      portableRoot: path.toNamespacedPath(portableRoot),
      restartMode: "viewer",
    });
    const lockPath = path.join(appDataRoot, "WonRemote", "updates", "update-handoff.lock");
    lockHolder = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$stream=[IO.File]::Open($env:LOCK_PATH,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
    ], {
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForProcessOutput(lockHolder, "LOCKED", 5_000);
    const exitCode = await runHandoff(handoff.command, handoff.args, 20_000, appDataRoot);
    if (exitCode !== 20) {
      throw new Error(`Concurrent portable handoff should exit 20, got ${exitCode}.`);
    }
    const viewerHashAfterContention = await sha256File(path.join(portableRoot, "WonRemote Viewer.exe"));
    if (viewerHashAfterContention !== oldViewerHash) {
      throw new Error("Concurrent portable handoff modified the portable root despite lock contention.");
    }
    console.log("Portable update lock E2E passed: concurrent handoff exited without touching the runtime.");
  } finally {
    if (lockHolder && lockHolder.exitCode === null) {
      await new Promise<void>((resolve) => {
        lockHolder?.once("exit", () => resolve());
        lockHolder?.kill();
      });
    }
    await stopProcessesUnder(portableRoot);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function waitForProcessOutput(
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${expected}`)), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!output.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Lock holder exited ${String(code)} before reporting ${expected}.`));
      }
    });
  });
}

async function runScenario(scenario: (typeof scenarios)[number]) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wonremote-portable-handoff-"));
  const portableRoot = path.join(fixtureRoot, "portable");
  const appDataRoot = path.join(fixtureRoot, "appdata");
  try {
    await expandArchive(scenario.oldArchive, portableRoot);
    if (scenario.restartMode === "agent") {
      await seedRegisteredAgentConfig(appDataRoot);
    }
    const oldExecutableHash = await sha256File(path.join(portableRoot, scenario.executableName));
    const archiveBytes = await readFile(scenario.newArchive);
    const metadata = {
      assetName: path.basename(scenario.newArchive),
      checksum: createHash("sha256").update(archiveBytes).digest("hex"),
      downloadUrl: `https://fixture.invalid/${path.basename(scenario.newArchive)}`,
      forceUpdate: false,
      latestVersion: currentVersion,
      reloadViewer: false,
      updateKind: scenario.packageKind,
    };
    const download = await downloadPortableUpdate(metadata, {
      baseDir: appDataRoot,
      fetchImpl: async () => new Response(archiveBytes),
    });
    const handoff = await preparePortableHandoff(download, {
      baseDir: appDataRoot,
      portableRoot: path.toNamespacedPath(portableRoot),
      restartMode: scenario.restartMode,
    });
    const exitCode = await runHandoff(handoff.command, handoff.args, 60_000, appDataRoot);
    if (exitCode !== 0) {
      const log = await readFile(handoff.logPath, "utf8").catch(() => "<missing log>");
      throw new Error(`Portable update handoff exited ${exitCode}.\n${log}`);
    }

    const marker = JSON.parse(
      await readFile(path.join(portableRoot, PORTABLE_MARKER_FILENAME), "utf8"),
    ) as { packageKind?: unknown; version?: unknown };
    if (marker.packageKind !== scenario.packageKind || marker.version !== currentVersion) {
      throw new Error(`Updated portable marker is invalid: ${JSON.stringify(marker)}`);
    }
    const newExecutableHash = await sha256File(path.join(portableRoot, scenario.executableName));
    if (newExecutableHash === oldExecutableHash) {
      throw new Error(`${scenario.label} executable was not replaced.`);
    }

    console.log(`Portable update E2E passed: legacy 0.1.39 ${scenario.label} ZIP -> ${currentVersion} in-place update.`);
  } finally {
    await stopProcessesUnder(portableRoot);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function runRollbackScenario() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wonremote-portable-rollback-"));
  const portableRoot = path.join(fixtureRoot, "portable");
  const badPayloadRoot = path.join(fixtureRoot, "bad-payload");
  const badArchive = path.join(fixtureRoot, "bad-portable.zip");
  const appDataRoot = path.join(fixtureRoot, "appdata");
  try {
    await expandArchive(scenarios[0].oldArchive, portableRoot);
    await expandArchive(scenarios[0].newArchive, badPayloadRoot);
    const oldViewerHash = await sha256File(path.join(portableRoot, "WonRemote Viewer.exe"));
    await writeFile(path.join(badPayloadRoot, "WonRemote Viewer.exe"), "intentionally invalid executable");
    await compressDirectory(badPayloadRoot, badArchive);
    const archiveBytes = await readFile(badArchive);
    const download = await downloadPortableUpdate({
      assetName: "WonRemote-Viewer-Agent-Portable.zip",
      checksum: createHash("sha256").update(archiveBytes).digest("hex"),
      downloadUrl: "https://fixture.invalid/WonRemote-Viewer-Agent-Portable.zip",
      forceUpdate: false,
      latestVersion: currentVersion,
      reloadViewer: false,
      updateKind: "portable",
    }, {
      baseDir: appDataRoot,
      fetchImpl: async () => new Response(archiveBytes),
    });
    const handoff = await preparePortableHandoff(download, {
      baseDir: appDataRoot,
      portableRoot: path.toNamespacedPath(portableRoot),
      restartMode: "viewer",
    });
    const exitCode = await runHandoff(handoff.command, handoff.args, 60_000, appDataRoot);
    if (exitCode !== 1) {
      throw new Error(`Broken portable payload should roll back with exit 1, got ${exitCode}.`);
    }
    const restoredViewerHash = await sha256File(path.join(portableRoot, "WonRemote Viewer.exe"));
    const log = await readFile(handoff.logPath, "utf8");
    if (restoredViewerHash !== oldViewerHash || !log.includes("Previous portable version restored and restarted")) {
      throw new Error(`Portable rollback did not restore the previous executable.\n${log}`);
    }
    console.log("Portable rollback E2E passed: invalid replacement restored and restarted legacy x64 Viewer.");
  } finally {
    await stopProcessesUnder(portableRoot);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function runAgentChildRollbackScenario() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wonremote-portable-agent-rollback-"));
  const portableRoot = path.join(fixtureRoot, "portable");
  const badPayloadRoot = path.join(fixtureRoot, "bad-payload");
  const badArchive = path.join(fixtureRoot, "bad-agent-portable.zip");
  const appDataRoot = path.join(fixtureRoot, "appdata");
  try {
    await expandArchive(scenarios[1].oldArchive, portableRoot);
    await seedRegisteredAgentConfig(appDataRoot);
    await expandArchive(scenarios[1].newArchive, badPayloadRoot);
    const oldAgentBundleHash = await sha256File(path.join(portableRoot, "agent", "index.mjs"));
    await writeFile(
      path.join(badPayloadRoot, "agent", "index.mjs"),
      "throw new Error('intentional Agent child startup failure');\n",
    );
    await compressDirectory(badPayloadRoot, badArchive);
    const archiveBytes = await readFile(badArchive);
    const download = await downloadPortableUpdate({
      assetName: "WonRemote-Agent-Portable-x86.zip",
      checksum: createHash("sha256").update(archiveBytes).digest("hex"),
      downloadUrl: "https://fixture.invalid/WonRemote-Agent-Portable-x86.zip",
      forceUpdate: false,
      latestVersion: currentVersion,
      reloadViewer: false,
      updateKind: "portable-agent",
    }, {
      baseDir: appDataRoot,
      fetchImpl: async () => new Response(archiveBytes),
    });
    const handoff = await preparePortableHandoff(download, {
      baseDir: appDataRoot,
      portableRoot: path.toNamespacedPath(portableRoot),
      restartMode: "agent",
    });
    const exitCode = await runHandoff(handoff.command, handoff.args, 60_000, appDataRoot);
    if (exitCode !== 1) {
      throw new Error(`Broken Agent child should roll back with exit 1, got ${exitCode}.`);
    }
    const restoredAgentBundleHash = await sha256File(path.join(portableRoot, "agent", "index.mjs"));
    const log = await readFile(handoff.logPath, "utf8");
    if (
      restoredAgentBundleHash !== oldAgentBundleHash ||
      !log.includes("Previous portable version restored and restarted")
    ) {
      throw new Error(`Portable Agent-child rollback did not restore the previous bundle.\n${log}`);
    }
    console.log("Portable Agent health E2E passed: dead node.exe child triggered rollback and restart.");
  } finally {
    await stopProcessesUnder(portableRoot);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function seedRegisteredAgentConfig(appDataRoot: string): Promise<void> {
  const source = path.join(process.env.APPDATA || "", "WonRemote", "agent-config.json");
  const config = await readFile(source).catch(() => null);
  if (!config) {
    throw new Error(`Registered Agent config is required for runtime health E2E: ${source}`);
  }
  const destination = path.join(appDataRoot, "WonRemote", "agent-config.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, config);
}

async function expandArchive(archivePath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await execFileAsync("tar.exe", ["-xf", archivePath, "-C", destination], { windowsHide: true });
}

async function compressDirectory(source: string, destination: string): Promise<void> {
  const script = [
    "$source = $env:WONREMOTE_TEST_ARCHIVE_SOURCE",
    "$destination = $env:WONREMOTE_TEST_ARCHIVE_DESTINATION",
    "$items = Get-ChildItem -LiteralPath $source",
    "Compress-Archive -LiteralPath $items.FullName -DestinationPath $destination -CompressionLevel Optimal -Force",
  ].join("\n");
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: {
      ...process.env,
      WONREMOTE_TEST_ARCHIVE_DESTINATION: destination,
      WONREMOTE_TEST_ARCHIVE_SOURCE: source,
    },
    windowsHide: true,
  });
}

function runHandoff(
  command: string,
  args: string[],
  timeoutMs: number,
  appDataRoot: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, APPDATA: appDataRoot },
      stdio: "ignore",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Portable update handoff exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function stopProcessesUnder(root: string): Promise<void> {
  const script = [
    "$root = [System.IO.Path]::GetFullPath($env:WONREMOTE_TEST_PORTABLE_ROOT).TrimEnd('\\')",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ExecutablePath -and [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("\n");
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, WONREMOTE_TEST_PORTABLE_ROOT: root },
    windowsHide: true,
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 750));
}

await main();
