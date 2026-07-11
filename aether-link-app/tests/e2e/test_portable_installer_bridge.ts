import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = path.join(os.tmpdir(), "wonremote-portable-update-e2e");
const expectedVersion = String(
  (JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as { version: unknown }).version,
);
const markerFilename = "wonremote-portable.json";
const sentinelFilename = "portable-e2e-user-data.keep";
const installerTimeoutMs = 120_000;

type PackageKind = "portable" | "portable-agent";

type Scenario = {
  expectedExecutables: string[];
  installerPath: string;
  label: string;
  legacyArchivePath: string;
  legacyRestartCommand: "Start-WonRemoteAgent" | "Start-WonRemoteViewer";
  packageKind: PackageKind;
  replacedExecutable: string;
};

type ProcessInfo = {
  CommandLine?: string | null;
  ExecutablePath?: string | null;
  Name?: string | null;
  ProcessId?: number | null;
};

const scenarios: Scenario[] = [
  {
    expectedExecutables: ["WonRemote Viewer.exe", "WonRemote Agent.exe"],
    installerPath: path.join(appRoot, "release-exe", "WonRemote-Viewer-Agent-Setup.exe"),
    label: "x64 combined legacy portable",
    legacyArchivePath: path.join(fixtureRoot, "old-combined-x64.zip"),
    legacyRestartCommand: "Start-WonRemoteViewer",
    packageKind: "portable",
    replacedExecutable: "WonRemote Viewer.exe",
  },
  {
    expectedExecutables: ["WonRemote Agent.exe"],
    installerPath: path.join(appRoot, "release-exe", "WonRemote-Viewer-Agent-Setup-x86.exe"),
    label: "x86 Agent-only legacy portable",
    legacyArchivePath: path.join(fixtureRoot, "old-agent-x86.zip"),
    legacyRestartCommand: "Start-WonRemoteAgent",
    packageKind: "portable-agent",
    replacedExecutable: "WonRemote Agent.exe",
  },
];

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Portable installer bridge E2E requires Windows and NSIS.");
  }

  await assertVersionAndInputs();
  await assertBridgePackagingReady();
  await assertNoExternalWonRemoteMutexOwners();

  for (const scenario of scenarios) {
    await runScenario(scenario);
  }

  console.log("Portable installer bridge E2E passed for x64 combined and x86 Agent-only legacy packages.");
}

async function runScenario(scenario: Scenario): Promise<void> {
  const scenarioRoot = await mkdtemp(path.join(os.tmpdir(), "wonremote-portable-installer-bridge-"));
  const portableRoot = path.join(scenarioRoot, "portable-root");
  const appDataRoot = path.join(scenarioRoot, "AppData", "Roaming");
  const localAppDataRoot = path.join(scenarioRoot, "AppData", "Local");
  const tempRoot = path.join(scenarioRoot, "Temp");
  const sentinelPath = path.join(portableRoot, sentinelFilename);

  try {
    await Promise.all([
      mkdir(portableRoot, { recursive: true }),
      mkdir(appDataRoot, { recursive: true }),
      mkdir(localAppDataRoot, { recursive: true }),
      mkdir(tempRoot, { recursive: true }),
    ]);
    await expandArchive(scenario.legacyArchivePath, portableRoot);
    await assertLegacyFixture(portableRoot, scenario);
    await writeFile(sentinelPath, `${scenario.label}\n`, "utf8");
    const registeredConfigPath = path.join(process.env.APPDATA || "", "WonRemote", "agent-config.json");
    await requireFile(registeredConfigPath, "registered Agent config for runtime health verification");
    await mkdir(path.join(appDataRoot, "WonRemote"), { recursive: true });
    await writeFile(
      path.join(appDataRoot, "WonRemote", "agent-config.json"),
      await readFile(registeredConfigPath),
    );
    const legacyHandoffPath = path.join(appDataRoot, "WonRemote", "updates", "run-installer-update.ps1");
    await mkdir(path.dirname(legacyHandoffPath), { recursive: true });
    await writeFile(
      legacyHandoffPath,
      `if ($process.ExitCode -eq 0) {\n  ${scenario.legacyRestartCommand}\n}\n`,
      "utf8",
    );

    const oldExecutableHash = await sha256File(path.join(portableRoot, scenario.replacedExecutable));
    const installerEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: appDataRoot,
      LOCALAPPDATA: localAppDataRoot,
      TEMP: tempRoot,
      TMP: tempRoot,
      WONREMOTE_APP_DIR: path.toNamespacedPath(portableRoot),
    };
    delete installerEnvironment.WONREMOTE_PACKAGE_KIND;

    const exitCode = await runInstaller(scenario.installerPath, installerEnvironment);
    if (exitCode !== 0) {
      const bridgeLogPath = path.join(
        appDataRoot,
        "WonRemote",
        "updates",
        "portable-installer-bridge",
        "bridge.log",
      );
      const bridgeLog = await readFile(bridgeLogPath, "utf8").catch(() => "<missing bridge log>");
      throw new Error(`${scenario.label} installer exited with code ${String(exitCode)}.\n${bridgeLog}`);
    }

    await assertPortableRootWasUpdated(portableRoot, scenario, oldExecutableHash, sentinelPath);
    await assertNoInstalledLayout(localAppDataRoot, scenario);
    await waitForPortableProcesses(portableRoot, scenario.expectedExecutables, 20_000);

    console.log(`${scenario.label}: legacy v0.1.39 -> v${expectedVersion} in-place bridge passed.`);
  } finally {
    await stopProcessesStrictlyUnder(portableRoot);
    await removeIsolatedTempTree(scenarioRoot);
  }
}

async function assertVersionAndInputs(): Promise<void> {
  const packageJson = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (packageJson.version !== expectedVersion) {
    throw new Error(`This E2E requires WonRemote ${expectedVersion}; package.json is ${String(packageJson.version)}.`);
  }

  for (const scenario of scenarios) {
    await requireFile(scenario.legacyArchivePath, `${scenario.label} legacy fixture`);
    await requireFile(scenario.installerPath, `${scenario.label} combined NSIS installer`);
  }
}

async function assertBridgePackagingReady(): Promise<void> {
  const packageScriptPath = path.join(appRoot, "scripts", "package-release-exes.js");
  const bridgeScriptPath = path.join(appRoot, "scripts", "portable-installer-bridge.ps1");
  const packageSource = await readFile(packageScriptPath, "utf8");
  await requireFile(bridgeScriptPath, "portable installer bridge script");

  const requiredPackagingTokens = [
    "portable-installer-bridge.ps1",
    "WONREMOTE_APP_DIR",
    "WonRemote-Viewer-Agent-Portable.zip",
    "WonRemote-Agent-Portable.zip",
  ];
  const missingTokens = requiredPackagingTokens.filter((token) => !packageSource.includes(token));
  if (missingTokens.length > 0) {
    throw new Error(
      `Portable installer bridge is not packaged yet; missing from package-release-exes.js: ${missingTokens.join(", ")}.`,
    );
  }

  const sourceMtime = Math.max(
    (await stat(packageScriptPath)).mtimeMs,
    (await stat(bridgeScriptPath)).mtimeMs,
  );
  for (const scenario of scenarios) {
    if ((await stat(scenario.installerPath)).mtimeMs < sourceMtime) {
      throw new Error(
        `${scenario.label} installer predates its bridge source. Rebuild release:exes before running physical E2E.`,
      );
    }
  }
}

async function assertLegacyFixture(portableRoot: string, scenario: Scenario): Promise<void> {
  if (await exists(path.join(portableRoot, markerFilename))) {
    throw new Error(`${scenario.label} fixture is not legacy: ${markerFilename} already exists.`);
  }
  for (const executable of scenario.expectedExecutables) {
    await requireFile(path.join(portableRoot, executable), `${scenario.label} ${executable}`);
  }
  if (scenario.packageKind === "portable") {
    await requireFile(path.join(portableRoot, "WonRemote Viewer.exe"), `${scenario.label} WonRemote Viewer.exe`);
  }
  if (scenario.packageKind === "portable-agent" && await exists(path.join(portableRoot, "WonRemote Viewer.exe"))) {
    throw new Error("x86 Agent-only legacy fixture unexpectedly contains WonRemote Viewer.exe.");
  }
}

async function assertPortableRootWasUpdated(
  portableRoot: string,
  scenario: Scenario,
  oldExecutableHash: string,
  sentinelPath: string,
): Promise<void> {
  const marker = JSON.parse(await readFile(path.join(portableRoot, markerFilename), "utf8")) as {
    packageKind?: unknown;
    schemaVersion?: unknown;
    version?: unknown;
  };
  const expectedMarker = {
    packageKind: scenario.packageKind,
    schemaVersion: 1,
    version: expectedVersion,
  };
  if (
    marker.schemaVersion !== expectedMarker.schemaVersion ||
    marker.packageKind !== expectedMarker.packageKind ||
    marker.version !== expectedMarker.version
  ) {
    throw new Error(`${scenario.label} marker mismatch: ${JSON.stringify(marker)}.`);
  }

  const newExecutableHash = await sha256File(path.join(portableRoot, scenario.replacedExecutable));
  if (newExecutableHash === oldExecutableHash) {
    throw new Error(`${scenario.label} executable was not replaced in the portable root.`);
  }
  if ((await readFile(sentinelPath, "utf8")) !== `${scenario.label}\n`) {
    throw new Error(`${scenario.label} portable root was replaced instead of updated in place.`);
  }
}

async function assertNoInstalledLayout(localAppDataRoot: string, scenario: Scenario): Promise<void> {
  const installedRoots = [
    path.join(localAppDataRoot, "WonRemote", "Viewer"),
    path.join(localAppDataRoot, "WonRemote", "Agent"),
    path.join(localAppDataRoot, "WonRemote Viewer"),
    path.join(localAppDataRoot, "WonRemote Agent"),
  ];
  const created = [];
  for (const installedRoot of installedRoots) {
    if (await exists(installedRoot)) {
      created.push(installedRoot);
    }
  }
  if (created.length > 0) {
    throw new Error(
      `${scenario.label} escaped portable mode and created installed layout: ${created.join(", ")}.`,
    );
  }
}

async function assertNoExternalWonRemoteMutexOwners(): Promise<void> {
  const processes = await listWonRemoteShellProcesses();
  if (processes.length === 0) {
    return;
  }
  const details = processes.map((process) =>
    `PID ${String(process.ProcessId)} ${process.ExecutablePath || process.Name || "<unknown path>"} ${process.CommandLine || ""}`.trim(),
  );
  throw new Error(
    `WonRemote Viewer/Agent is already running and may own the global mode mutex. ` +
    `This E2E will not terminate external processes. Stop them manually and retry.\n${details.join("\n")}`,
  );
}

async function listWonRemoteShellProcesses(): Promise<ProcessInfo[]> {
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object {",
    "  if (-not $_.ExecutablePath) { return $false }",
    "  $leaf = [System.IO.Path]::GetFileName($_.ExecutablePath)",
    "  $isPortableShell = $leaf -ieq 'WonRemote Viewer.exe' -or $leaf -ieq 'WonRemote Agent.exe'",
    "  $isInstalledShell = $leaf -ieq 'wonremote-viewer.exe' -and $_.ExecutablePath -match '\\\\WonRemote\\\\(Viewer|Agent)\\\\'",
    "  return $isPortableShell -or $isInstalledShell",
    "} | Select-Object ProcessId, Name, ExecutablePath, CommandLine",
    "@($items) | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout.trim() || "[]") as ProcessInfo[] | ProcessInfo;
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function waitForPortableProcesses(
  portableRoot: string,
  expectedExecutables: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processes = await listProcessesStrictlyUnder(portableRoot);
    const runningNames = new Set(
      processes
        .map((process) => process.ExecutablePath ? path.basename(process.ExecutablePath).toLowerCase() : "")
        .filter(Boolean),
    );
    if (expectedExecutables.every((name) => runningNames.has(name.toLowerCase()))) {
      return;
    }
    await delay(500);
  }
  throw new Error(
    `Updated portable runtime did not start under ${portableRoot}: expected ${expectedExecutables.join(", ")}.`,
  );
}

async function listProcessesStrictlyUnder(portableRoot: string): Promise<ProcessInfo[]> {
  const script = [
    "$root = [System.IO.Path]::GetFullPath($env:WONREMOTE_TEST_PORTABLE_ROOT).TrimEnd('\\')",
    "$prefix = $root + '\\'",
    "$items = Get-CimInstance Win32_Process | Where-Object {",
    "  if (-not $_.ExecutablePath) { return $false }",
    "  $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)",
    "  return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)",
    "} | Select-Object ProcessId, Name, ExecutablePath, CommandLine",
    "@($items) | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, WONREMOTE_TEST_PORTABLE_ROOT: portableRoot },
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout.trim() || "[]") as ProcessInfo[] | ProcessInfo;
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopProcessesStrictlyUnder(portableRoot: string): Promise<void> {
  if (!await exists(portableRoot)) {
    return;
  }
  const script = [
    "$root = [System.IO.Path]::GetFullPath($env:WONREMOTE_TEST_PORTABLE_ROOT).TrimEnd('\\')",
    "$prefix = $root + '\\'",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  if (-not $_.ExecutablePath) { return $false }",
    "  $candidate = [System.IO.Path]::GetFullPath($_.ExecutablePath)",
    "  return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("\n");
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, WONREMOTE_TEST_PORTABLE_ROOT: portableRoot },
    windowsHide: true,
  }).catch(() => undefined);
  await delay(750);
}

async function runInstaller(installerPath: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(installerPath, ["/S"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => {
      if (child.pid) {
        void execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      }
      reject(new Error(`Installer timed out after ${installerTimeoutMs}ms: ${installerPath}`));
    }, installerTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && (stdout.trim() || stderr.trim())) {
        reject(new Error(`Installer exited ${String(code)}.\n${stdout}\n${stderr}`));
        return;
      }
      resolve(code);
    });
  });
}

async function expandArchive(archivePath: string, destination: string): Promise<void> {
  await execFileAsync("tar.exe", ["-xf", archivePath, "-C", destination], { windowsHide: true });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function requireFile(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

async function exists(targetPath: string): Promise<boolean> {
  return access(targetPath).then(() => true, () => false);
}

async function removeIsolatedTempTree(targetPath: string): Promise<void> {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedTemp = path.resolve(os.tmpdir());
  const tempPrefix = `${resolvedTemp}${path.sep}`.toLowerCase();
  if (!resolvedTarget.toLowerCase().startsWith(tempPrefix)) {
    throw new Error(`Refusing to remove non-temporary E2E path: ${resolvedTarget}`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
