import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { nsisHostBytes, stageAgentFileUpdate } from "./package-agent-file-update.js";

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windowsRoot = path.resolve("src-tauri/windows");

describe("Agent file replacement, not Setup", () => {
  it("preserves the host bytes except Tauri's one normal NSIS bundle identity patch", () => {
    const raw = Buffer.from("MZ prefix __TAURI_BUNDLE_TYPE_VAR_NSS data __TAURI_BUNDLE_TYPE_VAR_UNK suffix");
    expect(nsisHostBytes(raw).toString()).toBe(raw.toString().replace("_VAR_UNK", "_VAR_NSS"));
    expect(raw.toString()).toContain("_VAR_UNK");
    expect(() => nsisHostBytes(Buffer.concat([raw, raw]))).toThrow(/one unbundled/);
    expect(() => nsisHostBytes(Buffer.from("not a Tauri host"))).toThrow(/one unbundled/);
  });
  it("stages exactly current resources and installed helpers, not config or uninstaller", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-file-update-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "src-tauri/windows"), { recursive: true });
    fs.mkdirSync(path.join(source, "dist-agent"));
    fs.writeFileSync(path.join(source, "dist-agent/index.mjs"), "fresh-runtime");
    fs.writeFileSync(path.join(source, "host.exe"), "fresh-host");
    fs.writeFileSync(path.join(source, "agent-config.json"), "must-not-package");
    fs.writeFileSync(path.join(source, "src-tauri/tauri.conf.json"), JSON.stringify({ bundle: { resources: { "../dist-agent/index.mjs": "agent/index.mjs" } } }));
    for (const name of ["manage-agent-login-task.ps1", "agent-update-health.ps1", "update-handoff-broker.ps1", "manage-agent-firewall.ps1"]) fs.writeFileSync(path.join(source, "src-tauri/windows", name), name);
    const payload = path.join(root, "payload");
    stageAgentFileUpdate(source, path.join(source, "host.exe"), payload);
    expect(fs.readFileSync(path.join(payload, "agent/index.mjs"), "utf8")).toBe("fresh-runtime");
    expect(fs.readFileSync(path.join(payload, "wonremote-viewer.exe"), "utf8")).toBe("fresh-host");
    expect(fs.existsSync(path.join(payload, "agent-config.json"))).toBe(false);
    expect(fs.existsSync(path.join(payload, "uninstall.exe"))).toBe(false);
    expect(() => stageAgentFileUpdate(source, path.join(source, "host.exe"), payload)).toThrow(/fresh/);
  });

  it("compiles the actual silent updater script and refuses a standalone launch before touching an installation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-update-nsis-"));
    temporaryDirectories.push(root);
    const payload = path.join(root, "payload");
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, "wonremote-viewer.exe"), "fixture-host-not-executable");
    const output = path.join(root, "update.exe");
    execFileSync(path.join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe"), ["/V2",
      `/DUPDATE_OUTPUT=${output}`, "/DUPDATE_VERSION=9.9.9", `/DUPDATE_PAYLOAD=${payload}`,
      path.join(windowsRoot, "agent-file-update.nsi")], { windowsHide: true });
    const bytes = fs.readFileSync(output);
    expect(bytes.toString("ascii", 0, 2)).toBe("MZ");
    expect(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)).toBe(0x14c);
    const version = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-Item -LiteralPath ${quote(output)}).VersionInfo.ProductVersion`], { encoding: "utf8", windowsHide: true }).trim();
    expect(version).toBe("9.9.9");
    expect(() => execFileSync(output, [], { windowsHide: true, timeout: 20_000,
      env: { ...process.env, WONREMOTE_HANDOFF_INSTALLER_PATH: "", WONREMOTE_HANDOFF_ACCEPTED_PATH: "" } })).toThrow();
    expect(fs.readFileSync(path.join(payload, "wonremote-viewer.exe"), "utf8")).toBe("fixture-host-not-executable");
  }, 30_000);

  it("confirms the real NSIS worker process identifies the exact launching updater", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-update-parent-"));
    temporaryDirectories.push(root);
    const payload = path.join(root, "payload");
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, "fixture.txt"), "fixture");
    fs.copyFileSync(path.join(windowsRoot, "agent-file-update.nsi"), path.join(root, "agent-file-update.nsi"));
    fs.copyFileSync(path.join(windowsRoot, "stop-wonremote-processes.ps1"), path.join(root, "stop-wonremote-processes.ps1"));
    const receipt = path.join(root, "caller.txt");
    fs.writeFileSync(path.join(root, "agent-file-update.ps1"), `param([string]$PayloadRoot)\n. ${quote(path.join(windowsRoot, "agent-file-update.ps1"))}\nGet-UpdateCallerPath | Set-Content -LiteralPath ${quote(receipt)}\nexit 0\n`);
    const output = path.join(root, "fixture.exe");
    execFileSync(path.join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe"), ["/V2",
      `/DUPDATE_OUTPUT=${output}`, "/DUPDATE_VERSION=9.9.9", `/DUPDATE_PAYLOAD=${payload}`,
      path.join(root, "agent-file-update.nsi")], { windowsHide: true });
    execFileSync(output, [], { windowsHide: true, timeout: 20_000 });
    expect(fs.readFileSync(receipt, "utf8").replace(/^\uFEFF/, "").trim().toLowerCase()).toBe(output.toLowerCase());
  }, 30_000);

  for (const scenario of ["success", "no-handoff", "wrong-caller", "unregistered", "outside-protected", "junction", "unexpected-entry", "incomplete", "copy-failure"]) {
    it(`executes a Windows filesystem fixture: ${scenario}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-update-executor-"));
      temporaryDirectories.push(root);
      const fixture = path.join(root, "fixture.ps1");
      fs.writeFileSync(fixture, `
$ErrorActionPreference = 'Stop'
. ${quote(path.join(windowsRoot, "agent-file-update.ps1"))}
$fixtureRoot = ${quote(root)}
$scenario = '${scenario}'
$install = Join-Path $fixtureRoot 'Program Files\\WonRemote Agent'
$payload = Join-Path $fixtureRoot 'payload'
$stage = Join-Path $install '.update-handoff\\abcdefff-1234-4123-8123-123456789abc'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $payload -Force | Out-Null
$names = @('wonremote-viewer.exe','agent\\index.mjs','server\\index.mjs','runtime\\node.exe','bin\\wonremote-poc.exe')
foreach ($name in $names) {
  foreach ($base in @($install, $payload)) {
    $target = Join-Path $base $name
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Set-Content -LiteralPath $target -Value $(if ($base -eq $install) { 'old' } else { 'new' })
  }
}
Set-Content -LiteralPath (Join-Path $install 'update-handoff-broker.ps1') -Value 'broker'
Set-Content -LiteralPath (Join-Path $install 'agent-config.json') -Value 'identity'
Set-Content -LiteralPath (Join-Path $install 'uninstall.exe') -Value 'original-uninstaller'
Set-Content -LiteralPath (Join-Path $stage 'installer.exe') -Value 'fixture-updater'
$env:WONREMOTE_HANDOFF_INSTALLER_PATH = Join-Path $stage 'installer.exe'
$env:ProgramFiles = Split-Path -Parent $install
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', $env:ProgramFiles)
$env:ProgramW6432 = $env:ProgramFiles
function Get-RegisteredAgentRoots { if ($scenario -ne 'unregistered') { return $install } }
function Get-UpdateCallerPath { if ($scenario -eq 'wrong-caller') { return 'C:\\untrusted.exe' }; return $env:WONREMOTE_HANDOFF_INSTALLER_PATH }
function Stop-AgentForFileUpdate([string]$Root) { Set-Content -LiteralPath (Join-Path $fixtureRoot 'stopped') -Value $Root }
if ($scenario -eq 'no-handoff') { Remove-Item Env:\\WONREMOTE_HANDOFF_INSTALLER_PATH }
if ($scenario -eq 'outside-protected') { $env:ProgramFiles = $fixtureRoot + '-other'; [Environment]::SetEnvironmentVariable('ProgramFiles(x86)', ''); $env:ProgramW6432 = '' }
if ($scenario -eq 'unexpected-entry') { Set-Content -LiteralPath (Join-Path $payload 'agent-config.json') -Value 'corrupt' }
if ($scenario -eq 'incomplete') { Remove-Item -LiteralPath (Join-Path $payload 'agent\\index.mjs') }
if ($scenario -eq 'junction') {
  $outside = Join-Path $fixtureRoot 'outside'
  New-Item -ItemType Directory -Path $outside | Out-Null
  Remove-Item -LiteralPath (Join-Path $install 'agent') -Recurse -Force
  New-Item -ItemType Junction -Path (Join-Path $install 'agent') -Target $outside | Out-Null
}
if ($scenario -eq 'copy-failure') {
  $locked = [IO.File]::Open((Join-Path $install 'wonremote-viewer.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
}
$failed = $false
try { Invoke-AgentFileUpdate $payload } catch { $failed = $true; $failure = $_.Exception.Message }
finally { if ($null -ne $locked) { $locked.Dispose() } }
if ($scenario -eq 'success') {
  if ($failed) { throw $failure }
  foreach ($name in $names) { if ((Get-Content -LiteralPath (Join-Path $install $name) -Raw).Trim() -ne 'new') { throw 'Bytes not replaced' } }
} else {
  if (-not $failed) { throw 'Unsafe update was accepted' }
  if ($scenario -ne 'copy-failure' -and (Test-Path -LiteralPath (Join-Path $fixtureRoot 'stopped'))) { throw 'Stopped before validation' }
}
if ((Get-Content -LiteralPath (Join-Path $install 'agent-config.json') -Raw).Trim() -ne 'identity') { throw 'Lost identity' }
if ((Get-Content -LiteralPath (Join-Path $install 'uninstall.exe') -Raw).Trim() -ne 'original-uninstaller') { throw 'Reinstalled' }
Write-Output ('PASS ' + $scenario)
`, "utf8");
      const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
      expect(result).toContain(`PASS ${scenario}`);
    }, 25_000);
  }
});
