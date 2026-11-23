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
    fs.writeFileSync(path.join(source, "dist-agent/updater.mjs"), "fresh-updater");
    fs.writeFileSync(path.join(source, "host.exe"), "fresh-host");
    fs.writeFileSync(path.join(source, "agent-config.json"), "must-not-package");
    fs.writeFileSync(path.join(source, "src-tauri/tauri.conf.json"), JSON.stringify({ bundle: { resources: { "../dist-agent/index.mjs": "agent/index.mjs" } } }));
    fs.writeFileSync(path.join(source, "src-tauri/tauri.agent.x86.conf.json"), JSON.stringify({ bundle: { resources: { "../dist-agent/updater.mjs": "updater/index.mjs" } } }));
    for (const name of ["manage-agent-login-task.ps1", "agent-update-health.ps1", "update-handoff-broker.ps1", "manage-agent-firewall.ps1"]) fs.writeFileSync(path.join(source, "src-tauri/windows", name), name);
    const payload = path.join(root, "payload");
    stageAgentFileUpdate(source, path.join(source, "host.exe"), payload);
    expect(fs.readFileSync(path.join(payload, "agent/index.mjs"), "utf8")).toBe("fresh-runtime");
    expect(fs.readFileSync(path.join(payload, "updater/index.mjs"), "utf8")).toBe("fresh-updater");
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
    fs.writeFileSync(path.join(root, "agent-file-update.ps1"), `param([string]$PayloadRoot,[int]$InstallerProcessId)\n. ${quote(path.join(windowsRoot, "agent-file-update.ps1"))} -InstallerProcessId $InstallerProcessId\nGet-UpdateCallerPath | Set-Content -LiteralPath ${quote(receipt)}\nexit 0\n`);
    const output = path.join(root, "fixture.exe");
    execFileSync(path.join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe"), ["/V2",
      `/DUPDATE_OUTPUT=${output}`, "/DUPDATE_VERSION=9.9.9", `/DUPDATE_PAYLOAD=${payload}`,
      path.join(root, "agent-file-update.nsi")], { windowsHide: true });
    execFileSync(output, [], { windowsHide: true, timeout: 20_000 });
    expect(fs.readFileSync(receipt, "utf8").replace(/^\uFEFF/, "").trim().toLowerCase()).toBe(output.toLowerCase());
  }, 30_000);

  it("validates an explicit NSIS ancestor across the native-x86 wrapper and rejects unrelated PIDs", () => {
    const script = `
. ${quote(path.join(windowsRoot, "agent-file-update.ps1"))}
$script:InstallerProcessId=9000
function Get-CimInstance {
  param($ClassName,$Filter)
  if($Filter -eq "ProcessId = $PID"){return [pscustomobject]@{ProcessId=$PID;ParentProcessId=8000}}
  if($Filter -eq 'ProcessId = 8000'){return [pscustomobject]@{ProcessId=8000;ParentProcessId=9000;ExecutablePath='C:\\Temp\\wrapper.tmp'}}
  if($Filter -eq 'ProcessId = 9000'){return [pscustomobject]@{ProcessId=9000;ParentProcessId=0;ExecutablePath='C:\\Program Files\\WonRemote Agent\\.update-handoff\\test\\installer.exe'}}
}
if((Get-UpdateCallerPath) -notlike '*\\.update-handoff\\test\\installer.exe'){throw 'Wrong NSIS caller'}
$script:InstallerProcessId=7777
$rejected=$false
try{Get-UpdateCallerPath}catch{$rejected=$true}
if(-not $rejected){throw 'Unrelated PID accepted'}
'validated-x86-caller'
`;
    expect(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")], {windowsHide:true,timeout:15000,encoding:"utf8"})).toContain("validated-x86-caller");
  });

  for (const scenario of ["success", "no-handoff", "wrong-caller", "unregistered", "outside-protected", "junction", "unexpected-entry", "incomplete", "missing-updater", "copy-failure", "late-copy-failure"]) {
    it(`executes a Windows filesystem fixture: ${scenario}`, () => {
      // .NET expands 8.3 TEMP aliases; match the real caller instead of mocking a different spelling.
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-update-executor-")));
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
$updater = Join-Path $payload 'updater\\index.mjs'
if ($scenario -ne 'missing-updater') {
  New-Item -ItemType Directory -Path (Split-Path -Parent $updater) | Out-Null
  Set-Content -LiteralPath $updater -Value 'new-updater'
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
if ($scenario -in @('copy-failure','late-copy-failure')) {
  $lockTarget = if ($scenario -eq 'copy-failure') { 'wonremote-viewer.exe' } else { 'bin\\wonremote-poc.exe' }
  $locked = [IO.File]::Open((Join-Path $install $lockTarget), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
}
$failed = $false
try { Invoke-AgentFileUpdate $payload } catch { $failed = $true; $failure = $_.Exception.Message }
finally { if ($null -ne $locked) { $locked.Dispose() } }
if ($scenario -eq 'success') {
  if ($failed) { throw $failure }
  foreach ($name in $names) { if ((Get-Content -LiteralPath (Join-Path $install $name) -Raw).Trim() -ne 'new') { throw 'Bytes not replaced' } }
  if ((Get-Content -LiteralPath (Join-Path $install 'updater\\index.mjs') -Raw).Trim() -ne 'new-updater') { throw 'Missing independent updater on legacy upgrade' }
} else {
  if (-not $failed) { throw 'Unsafe update was accepted' }
  if ($scenario -in @('copy-failure','late-copy-failure')) {
    if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'stopped'))) { throw 'Copy failure did not reach replacement' }
    foreach ($name in $names) {
      if ((Get-Content -LiteralPath (Join-Path $install $name) -Raw).Trim() -ne 'old') { throw "Partial replacement left $name on the new version" }
    }
    if (Test-Path -LiteralPath (Join-Path $install 'updater\\index.mjs')) { throw 'New updater survived the failed replacement' }
  } else {
    $expected = @{
      'no-handoff' = 'An existing protected Agent update handoff is required'
      'wrong-caller' = 'did not originate from the protected handoff'
      'unregistered' = 'No matching protected Agent installation exists'
      'outside-protected' = 'No matching protected Agent installation exists'
      'junction' = 'reparse point'
      'unexpected-entry' = 'Unexpected Agent update entry'
      'incomplete' = 'Incomplete Agent update'
      'missing-updater' = 'Incomplete Agent update: updater'
    }
    if (-not $failure.Contains($expected[$scenario])) { throw ('Wrong rejection: ' + $failure) }
    if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'stopped')) { throw 'Stopped before validation' }
  }
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

it("admits first hop only for the enrolled 123 and its fixed protected tasks", () => {
  const nativeSource = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");
  const guard = nativeSource.match(/let checks = r#"\r?\n([\s\S]+?)\r?\n"#;/)?.[1];
  expect(guard).toBeTruthy();
  const program = `
$env:WONREMOTE_FIRST_HOP_ROOT = 'C:\\Program Files (x86)\\WonRemote Agent'
$env:WONREMOTE_FIRST_HOP_UPDATES = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'WonRemote\\updates'
$root = $env:WONREMOTE_FIRST_HOP_ROOT
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$base = [Environment]::GetFolderPath('ProgramFilesX86')
if (-not $base) { $base = [Environment]::GetFolderPath('ProgramFiles') }
$protectedPayload = Join-Path $base 'test.tmp.wonremote-firsthop\\payload'
$env:WONREMOTE_FIRST_HOP_PAYLOAD = $protectedPayload
$env:WONREMOTE_FIRST_HOP_POWERSHELL = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$variant = 'matching'
function Test-Path { $true }
function Get-Item {
  $version = if ($variant -ceq 'wrong-version') { '0.1.125' } else { '0.1.123' }
  [pscustomobject]@{ Attributes=0; VersionInfo=[pscustomobject]@{ ProductVersion=$version } }
}
function Get-Acl {
  $writable = if ($variant -cin @('writable-stage','deletable-stage')) { 'S-1-5-32-545' } else { 'S-1-5-32-544' }
  $rights = if ($variant -ceq 'deletable-stage') { 'DeleteSubdirectoriesAndFiles' } else { 'Write' }
  $object = [pscustomobject]@{ Writer = $writable; Rights=$rights }
  Add-Member -InputObject $object -MemberType ScriptMethod -Name GetOwner -Value { [pscustomobject]@{ Value = 'S-1-5-32-544' } }
  Add-Member -InputObject $object -MemberType ScriptMethod -Name GetAccessRules -Value {
    [pscustomobject]@{
      AccessControlType='Allow'; IdentityReference=[pscustomobject]@{Value=$this.Writer}
      FileSystemRights=[Security.AccessControl.FileSystemRights]$this.Rights; PropagationFlags=0
    }
  }
  $object
}
function Get-ScheduledTask($TaskPath,$TaskName) {
  $principal = [pscustomobject]@{ UserId=$sid; RunLevel='Highest'; LogonType='Interactive' }
  $settings = [pscustomobject]@{ Enabled=$true; AllowDemandStart=$true }
  if ($TaskName -ceq 'WonRemote Agent') {
    $action = [pscustomobject]@{ Execute=(Join-Path $root 'wonremote-viewer.exe'); Arguments='--agent' }
  } elseif ($TaskName -ceq 'WonRemote Agent Update Handoff') {
    $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + [char]34 + (Join-Path $root 'update-handoff-broker.ps1') + [char]34
    if ($variant -ceq 'wrong-broker') { $arguments += ' -unexpected' }
    if ($variant -ceq 'wrong-user') { $principal.UserId = 'S-1-5-18' }
    $action = [pscustomobject]@{ Execute=$ps; Arguments=$arguments; WorkingDirectory=$root }
  } else { throw 'Unexpected task lookup.' }
  [pscustomobject]@{ Actions=@($action); Principal=$principal; State='Ready'; Settings=$settings; Triggers=@() }
}
$cases = @('matching','wrong-version','wrong-broker','wrong-user','writable-stage','deletable-stage','user-temp')
$observed = @(foreach ($variant in $cases) {
  $env:WONREMOTE_FIRST_HOP_PAYLOAD = if ($variant -ceq 'user-temp') { Join-Path $env:TEMP 'payload' } else { $protectedPayload }
  try { & ([scriptblock]::Create(${quote(guard)})); $true } catch { $false }
})
ConvertTo-Json -InputObject $observed -Compress
`;
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(program, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
  expect(JSON.parse(result)).toEqual([true, false, false, false, false, false, false]);
});
