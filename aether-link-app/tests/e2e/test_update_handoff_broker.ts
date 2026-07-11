import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile, copyFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const appRoot = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = path.join(os.tmpdir(), `wonremote-update-broker-e2e-${process.pid}`);

type BrokerScenario = {
  arch: "x64" | "x86";
  nodeSource: string;
  pocSource: string;
  shellSource: string;
};

const scenarios: BrokerScenario[] = [
  {
    arch: "x64",
    nodeSource: path.join(appRoot, "release-exe", "runtime", "node.exe"),
    pocSource: path.join(appRoot, "release-exe", "bin", "wonremote-poc.exe"),
    shellSource: path.join(appRoot, "src-tauri", "target", "release", "wonremote-viewer.exe"),
  },
  {
    arch: "x86",
    nodeSource: path.join(appRoot, "release-exe", "x86", "runtime", "node.exe"),
    pocSource: path.join(appRoot, "release-exe", "x86", "bin", "wonremote-poc.exe"),
    shellSource: path.join(
      appRoot,
      "src-tauri",
      "target",
      "i686-pc-windows-msvc",
      "release",
      "wonremote-viewer.exe",
    ),
  },
];

async function main(): Promise<void> {
  await rm(fixtureRoot, { recursive: true, force: true });
  try {
    for (const scenario of scenarios) {
      await runScenario(scenario);
    }
    console.log("Tauri update handoff broker E2E passed for x64 and x86.");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function runScenario(scenario: BrokerScenario): Promise<void> {
  await Promise.all([scenario.nodeSource, scenario.pocSource, scenario.shellSource].map(assertFileExists));

  const root = path.join(fixtureRoot, scenario.arch);
  const appData = path.join(root, "AppData", "Roaming");
  const localAppData = path.join(root, "AppData", "Local");
  const resourceRoot = path.join(root, "portable-agent");
  const updateRoot = path.join(appData, "WonRemote", "updates");
  const shellPath = path.join(resourceRoot, "WonRemote Agent.exe");
  const nodePath = path.join(resourceRoot, "runtime", "node.exe");
  const pocPath = path.join(resourceRoot, "bin", "wonremote-poc.exe");
  const agentPath = path.join(resourceRoot, "agent", "index.mjs");
  const handoffPath = path.join(updateRoot, `run-portable-update-broker-e2e-${scenario.arch}.ps1`);
  const proofPath = path.join(root, "broker-proof.txt");

  await Promise.all([
    mkdir(path.dirname(nodePath), { recursive: true }),
    mkdir(path.dirname(pocPath), { recursive: true }),
    mkdir(path.dirname(agentPath), { recursive: true }),
    mkdir(updateRoot, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(scenario.shellSource, shellPath),
    copyFile(scenario.nodeSource, nodePath),
    copyFile(scenario.pocSource, pocPath),
    writeFile(
      path.join(appData, "WonRemote", "agent-config.json"),
      JSON.stringify({
        apiUrl: "http://127.0.0.1:8787",
        businessNumber: "123-45-67890",
        installId: `broker-e2e-${scenario.arch}`,
        registeredDeviceId: `123-45-67890:BROKER-E2E-${scenario.arch}`,
        version: "0.1.40",
      }),
      "utf8",
    ),
    writeFile(
      path.join(resourceRoot, "wonremote-portable.json"),
      JSON.stringify({ packageKind: "portable-agent", schemaVersion: 1, version: "0.1.41" }),
      "utf8",
    ),
    writeFile(
      handoffPath,
      [
        "$ErrorActionPreference = 'Stop'",
        `$ShellPath = '${escapePowerShell(shellPath)}'`,
        "$Target = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $ShellPath } | Select-Object -First 1",
        "if ($null -eq $Target) { throw 'Fixture Tauri shell was not found.' }",
        "Stop-Process -Id $Target.ProcessId -Force",
        "Start-Sleep -Milliseconds 750",
        `Set-Content -LiteralPath '${escapePowerShell(proofPath)}' -Value 'broker-ok' -Encoding UTF8`,
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      agentPath,
      [
        "const scriptPath = process.env.WONREMOTE_BROKER_E2E_SCRIPT;",
        "if (!scriptPath) process.exit(2);",
        "console.log('[Status] Online');",
        "console.log('[WonRemoteUpdateHandoff]' + Buffer.from(scriptPath, 'utf8').toString('base64url'));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    ),
  ]);

  const child = spawn(shellPath, ["--agent"], {
    env: {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      WONREMOTE_BROKER_E2E_SCRIPT: handoffPath,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitForFile(proofPath, 20_000);
    const running = isProcessRunning(child.pid ?? -1);
    if (running) {
      throw new Error(`${scenario.arch} broker proof was written before the fixture Tauri shell exited.`);
    }
    console.log(`${scenario.arch} broker launched the verified PowerShell handoff outside the Agent Job Object.`);
  } finally {
    if (child.pid && isProcessRunning(child.pid)) {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  }
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Required broker E2E artifact is missing: ${filePath}`);
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for update broker proof: ${filePath}`);
}

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

await main();
