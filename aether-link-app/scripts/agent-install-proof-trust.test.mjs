import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-installed-agent-release.ps1", import.meta.url));

test("a verification key cannot authorize an installer on the main release runner", { skip: process.platform !== "win32" }, () => {
  const fixture = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", script, "-BaselineTag", "v0.1.123", "-CandidatePublicKeyFile", "not-a-real-key",
  ], {
    env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: process.env.TEMP, GITHUB_REF: "refs/heads/main" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.ifError(fixture.error);
  assert.notEqual(fixture.status, 0);
  assert.match(fixture.stderr, /only on the verification-only branch/);
});

test("baseline uses bundled trust and only the disposable candidate uses a fixture key", { skip: process.platform !== "win32" }, () => {
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const fixture = `
$ErrorActionPreference = 'Stop'
$fixtureRoot = ${quote(dirname(script))}
$nodeCommand = 'node'
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$null,[ref]$null)
$function = $ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Confirm-SignedRelease'},$true)
. ([scriptblock]::Create($function.Extent.Text.Replace('$PSScriptRoot', '$fixtureRoot')))
$script:uses = @()
function node {
  $script:uses += [string]$env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY
  $global:LASTEXITCODE = $script:exitCode
}
$env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = 'parent-key'
$script:exitCode = 0
Confirm-SignedRelease $fixtureRoot '0.1.123'
Confirm-SignedRelease $fixtureRoot '0.1.124' 'fixture-key'
$script:exitCode = 3
$failed = $false
try { Confirm-SignedRelease $fixtureRoot '0.1.124' 'rejected-key' } catch { $failed = $true }
@{uses=$script:uses;restored=$env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY;failed=$failed} | ConvertTo-Json -Compress
`;
  const observed = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fixture, "utf16le").toString("base64"),
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.ifError(observed.error);
  assert.equal(observed.status, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout), { uses: ["", "fixture-key", "rejected-key"], restored: "parent-key", failed: true });
});

test("the offline Sandbox mode refuses to run on this ordinary Windows host", { skip: process.platform !== "win32" || process.env.USERNAME === "WDAGUtilityAccount" }, () => {
  const fixture = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", script, "-BaselineTag", "v0.1.123",
    "-SandboxFixtureRoot", "not-a-real-fixture", "-CandidatePublicKeyFile", "not-a-real-key",
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.ifError(fixture.error);
  assert.notEqual(fixture.status, 0);
  assert.match(fixture.stderr, /must run inside Windows Sandbox/);
});
