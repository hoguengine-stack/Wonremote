import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile, copyFile, access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const appRoot = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = path.join(os.tmpdir(), `wonremote-update-broker-e2e-${process.pid}`);
const fixtureCleanup = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 } as const;
const BROKER_PROOF_TIMEOUT_MS = 30_000;

type BrokerScenario = {
  arch: "x64" | "x86";
  probeSource: string;
};

const allScenarios: BrokerScenario[] = [
  {
    arch: "x64",
    probeSource: path.join(appRoot, "src-tauri", "target", "release", "wonremote-job-probe.exe"),
  },
  {
    arch: "x86",
    probeSource: path.join(
      appRoot,
      "src-tauri",
      "target",
      "i686-pc-windows-msvc",
      "release",
      "wonremote-job-probe.exe",
    ),
  },
];
const requestedArch = process.env.WONREMOTE_BROKER_E2E_ARCH;
const scenarios = requestedArch
  ? allScenarios.filter((scenario) => scenario.arch === requestedArch)
  : allScenarios;
if (scenarios.length === 0) {
  throw new Error(`Unsupported broker E2E architecture filter: ${requestedArch}`);
}

async function main(): Promise<void> {
  await rm(fixtureRoot, fixtureCleanup);
  try {
    for (const scenario of scenarios) {
      await runScenario(scenario);
    }
    console.log(`Shared update handoff broker E2E passed for ${scenarios.map((scenario) => scenario.arch).join(" and ")}.`);
  } finally {
    await rm(fixtureRoot, fixtureCleanup);
  }
}

async function runScenario(scenario: BrokerScenario): Promise<void> {
  await assertFileExists(scenario.probeSource);

  const root = path.join(fixtureRoot, scenario.arch);
  const appData = path.join(root, "AppData", "Roaming");
  const localAppData = path.join(root, "AppData", "Local");
  const updateRoot = path.join(appData, "WonRemote", "updates");
  const probePath = path.join(root, "wonremote-job-probe.exe");
  const handoffPath = path.join(updateRoot, `run-portable-update-broker-e2e-${scenario.arch}.ps1`);
  const proofPath = path.join(root, "broker-proof.txt");
  const launcherPath = path.join(root, "launch-in-job.ps1");
  const launcherErrorPath = path.join(root, "launcher-error.txt");
  const probeErrorPath = path.join(root, "probe-error.txt");

  await Promise.all([
    mkdir(updateRoot, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(scenario.probeSource, probePath),
    writeFile(
      handoffPath,
      [
        "$ErrorActionPreference = 'Stop'",
        `$ProbePath = '${escapePowerShell(probePath)}'`,
        "$Target = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $ProbePath } | Select-Object -First 1",
        "if ($null -eq $Target) { throw 'Fixture update broker probe was not found.' }",
        "Stop-Process -Id $Target.ProcessId -Force",
        "Start-Sleep -Milliseconds 750",
        `Set-Content -LiteralPath '${escapePowerShell(proofPath)}' -Value 'broker-ok' -Encoding UTF8`,
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      launcherPath,
      windowsJobLauncherScript({
        appData,
        handoffPath,
        launcherErrorPath,
        localAppData,
        probeErrorPath,
        probePath,
      }),
      "utf8",
    ),
  ]);

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    try {
      await waitForFile(proofPath, BROKER_PROOF_TIMEOUT_MS);
    } catch (error) {
      let launcherError = "";
      let probeError = "";
      try {
        launcherError = await readFile(launcherErrorPath, "utf8");
      } catch {}
      try {
        probeError = await readFile(probeErrorPath, "utf8");
      } catch {}
      throw new Error(
        `${String(error)}${launcherError ? `\nJob launcher: ${launcherError}` : ""}${probeError ? `\nBroker probe: ${probeError}` : ""}`,
      );
    }
    await waitForProcessExit(child, 5_000);
    console.log(`${scenario.arch} broker survived the enclosing kill-on-close Job after the fixture probe exited.`);
  } finally {
    if (child.pid && isProcessRunning(child.pid)) {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  }
}

function windowsJobLauncherScript(options: {
  appData: string;
  handoffPath: string;
  launcherErrorPath: string;
  localAppData: string;
  probeErrorPath: string;
  probePath: string;
}): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class WonRemoteJobBoundary {
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

  public static IntPtr CreateKillOnCloseBreakawayJob() {
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800;
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(info, buffer, false);
      if (!SetInformationJobObject(job, 9, buffer, (uint)length)) {
        int error = Marshal.GetLastWin32Error();
        CloseHandle(job);
        throw new Win32Exception(error);
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
    return job;
  }
}
'@

try {
  $job = [WonRemoteJobBoundary]::CreateKillOnCloseBreakawayJob()
  $current = [System.Diagnostics.Process]::GetCurrentProcess()
  if (-not [WonRemoteJobBoundary]::AssignProcessToJobObject($job, $current.Handle)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $env:APPDATA = '${escapePowerShell(options.appData)}'
  $env:LOCALAPPDATA = '${escapePowerShell(options.localAppData)}'
  $env:WONREMOTE_BROKER_E2E_SCRIPT = '${escapePowerShell(options.handoffPath)}'
  $process = Start-Process -FilePath '${escapePowerShell(options.probePath)}' -WindowStyle Hidden -RedirectStandardError '${escapePowerShell(options.probeErrorPath)}' -PassThru
  $process.WaitForExit()
  [void][WonRemoteJobBoundary]::CloseHandle($job)
} catch {
  Set-Content -LiteralPath '${escapePowerShell(options.launcherErrorPath)}' -Value $_.Exception.ToString() -Encoding UTF8
  exit 1
}
`;
}

async function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the enclosing Job owner to exit.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
