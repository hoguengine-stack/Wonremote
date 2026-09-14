import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const approvedAssets = {
  "WonRemote-Viewer-Setup.exe": { size: 20318430, sha256: "f70f20e5d40c40910b724e6b3595be58a31c9ed0b4f61acaca68ac07ea35761d" },
  "WonRemote-Agent-Setup.exe": { size: 20322290, sha256: "7546dd3620fcaa9c7685efddd238ef6c6039811d194c0d497460558c2a013478" },
};
const repository = "hoguengine-stack/Wonremote";
const tag = "v0.1.94";

export function loadApprovedDraft(gh) {
  const release = JSON.parse(gh("api", `repos/${repository}/releases/388555161`));
  assertDraft(release);
  return release;
}

export function assertDraft(release) {
  if (release.tag_name !== tag || release.draft !== true) throw Error("Only approved unpublished v0.1.94 can be signed");
  if (!Array.isArray(release.assets) || release.assets.length !== 2) throw Error("Exactly two approved installers required");
  for (const [name, expected] of Object.entries(approvedAssets)) {
    const matches = release.assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || matches[0].state !== "uploaded" || matches[0].size !== expected.size
        || matches[0].digest !== `sha256:${expected.sha256}`) throw Error(`Unapproved asset: ${name}`);
  }
}

export function assertBytes(bytes, expected) {
  if (bytes.length !== expected.size || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw Error("Installer bytes do not match approval");
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw Error("Invalid executable");
  const offset = bytes.readUInt32LE(60);
  if (offset + 6 > bytes.length || bytes.toString("binary", offset, offset + 4) !== "PE\0\0" || bytes.readUInt16LE(offset + 4) !== 0x014c) throw Error("Expected x86 executable");
}

export function signApprovedRelease() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true });
  loadApprovedDraft(gh);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wonremote-approved-sign-"));
  for (const [name, expected] of Object.entries(approvedAssets)) {
    gh("release", "download", tag, "--repo", repository, "--pattern", name, "--dir", dir);
    assertBytes(fs.readFileSync(path.join(dir, name)), expected);
  }
  const viewer = path.join(dir, "WonRemote-Viewer-Setup.exe");
  const agent = path.join(dir, "WonRemote-Agent-Setup.exe");
  const manifest = path.join(dir, "wonremote-update-manifest.json");
  execFileSync(process.execPath, ["scripts/create-update-manifest.js", "--version", "0.1.94", "--release-tag", tag,
    "--viewer-x64", viewer, "--agent-x64", agent, "--force-update", "false", "--out", manifest], { cwd: appRoot, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/verify-release-manifest.js", "--manifest", manifest, "--version", "0.1.94",
    "--viewer-x64", viewer, "--agent-x64", agent], { cwd: appRoot, stdio: "inherit" });
  // Recheck draft identity before adding the public manifest; never publish or replace assets here.
  loadApprovedDraft(gh);
  gh("release", "upload", tag, manifest, "--repo", repository);
  console.log("Approved v0.1.94 manifest signed, trust-verified and uploaded to draft; not published.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) signApprovedRelease();
