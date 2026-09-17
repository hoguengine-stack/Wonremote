import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentHealthReporter } from "./agentUpdateHealth";

const identity = { registeredDeviceId: "business:AGENT-82220F6D", installId: "agent-82220f6d" };

describe("Agent update online readiness", () => {
  it("writes an atomic real receipt only for the server-accepted original identity", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "wonremote-online-"));
    try {
      const report = createAgentHealthReporter({ baseDir, version: "0.1.105" });
      const file = path.join(baseDir, "WonRemote", "agent-online.json");
      await report(identity, "other-device");
      await expect(readFile(file)).rejects.toThrow();
      await expect(readFile(path.join(baseDir, "WonRemote", ".update_success"))).rejects.toThrow();
      await Promise.all([report(identity, identity.registeredDeviceId), report(identity, identity.registeredDeviceId)]);
      const bytes = await readFile(file, "utf8");
      expect(await readFile(path.join(baseDir, "WonRemote", ".update_success"), "utf8")).toBe("SUCCESS");
      expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 1, version: "0.1.105", deviceId: identity.registeredDeviceId,
        installId: identity.installId, pid: process.pid, executablePath: process.execPath });
      await report(identity, identity.registeredDeviceId);
      expect(await readFile(file, "utf8")).toBe(bytes);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it("owns one concurrent write, no idle timer, and at most three failed attempts", async () => {
    vi.useFakeTimers();
    try {
      const writeReceipt = vi.fn(async () => { throw new Error("disk denied"); });
      const report = createAgentHealthReporter({ baseDir: "unused", version: "1", writeReceipt });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(writeReceipt).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 5; attempt++) {
        await Promise.allSettled(Array.from({ length: 8 }, () => report(identity, identity.registeredDeviceId)));
      }
      expect(writeReceipt).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.runIf(process.platform === "win32")("executes the PowerShell readiness predicate and bounded failure wait", () => {
    const helper = path.resolve("src-tauri/windows/agent-update-health.ps1").replace(/'/g, "''");
    const command = `
$ErrorActionPreference='Stop'
. '${helper}'
$root='C:\\Program Files (x86)\\WonRemote Agent'
$created=[datetime]::UtcNow.AddSeconds(-10)
$identity=@{registeredDeviceId='A';installId='I'}
$process=@{ProcessId=12;ExecutablePath=(Join-Path $root 'runtime\\node.exe');CommandLine=((Join-Path $root 'agent\\index.mjs') + ' --watch');CreationDate=$created}
$receipt=@{schemaVersion=1;version='0.1.105';deviceId='A';installId='I';pid=12;executablePath=$process.ExecutablePath;startedAt=$created.ToString('o');acceptedAt=[datetime]::UtcNow.ToString('o')}
function Check($r,$p,$since) { Test-AgentOnlineReceipt $r $p $root '0.1.105' $identity $since }
$since=$created.AddSeconds(-1)
if (-not (Check $receipt $process $since)) { throw 'valid receipt rejected' }
foreach ($key in @('version','deviceId','installId','pid','executablePath','startedAt','acceptedAt','schemaVersion')) {
  $bad=$receipt.Clone(); $bad[$key]='wrong'
  if (Check $bad $process $since) { throw "accepted bad $key" }
}
if (Check $receipt $null $since) { throw 'dead PID accepted' }
if (Check $receipt $process $created.AddSeconds(1)) { throw 'previous runtime accepted' }
$badProcess=$process.Clone(); $badProcess.CreationDate=$created.AddSeconds(5)
if (Check $receipt $badProcess $since) { throw 'reused PID accepted' }
$global:reads=0; $global:sleeps=0
function Get-Content { $global:reads++; return '{}' }
function Get-CimInstance { return $null }
function Start-Sleep { $global:sleeps++ }
try { Wait-AgentOnlineReceipt 'fixture' $root '0.1.105' $identity $since; throw 'bad wait passed' }
catch { if ($_.Exception.Message -notlike 'Agent online verification failed*') { throw } }
if ($global:reads -ne 60 -or $global:sleeps -ne 59) { throw "unbounded wait: $global:reads / $global:sleeps" }
$global:secureReads=0; $global:secureSleeps=0
function Get-ScheduledTask {
  param($TaskName,$ErrorAction)
  $global:secureReads++
  return [pscustomobject]@{Principal=[pscustomobject]@{UserId='SYSTEM';RunLevel='Highest'};Actions=[pscustomobject]@{Execute=(Join-Path $root 'bin\\wonremote-poc.exe');Arguments='--mode secure-broker'};State='Running'}
}
function Start-Sleep { $global:secureSleeps++ }
Wait-AgentSecureCaptureTask $root
if ($global:secureReads -ne 1 -or $global:secureSleeps -ne 0) { throw 'healthy secure broker was not accepted immediately' }
$global:secureReads=0; $global:secureSleeps=0
function Get-ScheduledTask { param($TaskName,$ErrorAction); $global:secureReads++; return $null }
try { Wait-AgentSecureCaptureTask $root; throw 'missing secure broker passed' }
catch { if ($_.Exception.Message -notlike 'Agent secure-desktop verification failed*') { throw } }
if ($global:secureReads -ne 40 -or $global:secureSleeps -ne 39) { throw "unbounded secure wait: $global:secureReads / $global:secureSleeps" }
'health-predicate-and-budget-ok'
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("health-predicate-and-budget-ok");
  }, 20000);

  it.runIf(process.platform === "win32")("verifies a living replacement Node and its accepted heartbeat across real process/file boundaries", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wonremote-health-process-")));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ device: { id: identity.registeredDeviceId } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(path.join(root, "runtime"));
      await mkdir(path.join(root, "agent"));
      const node = path.join(root, "runtime", "node.exe");
      await copyFile(process.execPath, node);
      const entry = path.join(root, "agent", "entry.ts");
      const script = path.join(root, "agent", "index.mjs");
      const port = (server.address() as { port: number }).port;
      await writeFile(entry, `import { createAgentHealthReporter } from ${JSON.stringify(path.resolve("src/agent/agentUpdateHealth.ts"))};
        const report = createAgentHealthReporter({baseDir:${JSON.stringify(root)},version:'0.1.105'});
        const response = await fetch('http://127.0.0.1:${port}/heartbeat');
        const result = await response.json();
        await report(${JSON.stringify(identity)}, result.device.id);
        console.log('ready'); setInterval(() => {}, 1000);`);
      await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: script });
      const since = new Date().toISOString();
      child = spawn(node, [script, "--watch"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture heartbeat timed out")), 10000);
        child!.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
        child!.once("error", error => { clearTimeout(timer); reject(error); });
        child!.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exit ${code}`)); });
      });
      const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const command = `. ${q(path.resolve("src-tauri/windows/agent-update-health.ps1"))};
        $identity = ${q(JSON.stringify(identity))} | ConvertFrom-Json;
        Wait-AgentOnlineReceipt ${q(path.join(root, "WonRemote", "agent-online.json"))} ${q(root)} '0.1.105' $identity ([datetime]${q(since)});
        'replacement-online'`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
        { encoding: "utf8", windowsHide: true, timeout: 70000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("replacement-online");
    } finally {
      if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 85000);
});
