import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function nsisHostBytes(source) {
  const bytes = Buffer.from(source);
  // Match Tauri's installed bundle identity, not its unbundled build identity.
  const unknown = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
  const installed = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS");
  const offset = bytes.indexOf(unknown);
  if (offset < 0 || bytes.indexOf(unknown, offset + 1) >= 0) {
    throw new Error("Expected one unbundled Tauri host marker before Agent file packaging.");
  }
  installed.copy(bytes, offset);
  return bytes;
}

export function stageAgentFileUpdate(root, hostPath, destination) {
  if (fs.existsSync(destination)) throw new Error(`Agent update staging must be fresh: ${destination}`);
  const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const entries = [[hostPath, "wonremote-viewer.exe"]];
  for (const [source, target] of Object.entries(config.bundle.resources)) {
    if (!/^(agent|server|runtime|bin|node_modules|icons)\//.test(target) || target.includes("..")) {
      throw new Error(`Unexpected Agent resource destination: ${target}`);
    }
    entries.push([path.resolve(root, "src-tauri", source), target]);
  }
  for (const name of ["manage-agent-login-task.ps1", "agent-update-health.ps1", "update-handoff-broker.ps1", "manage-agent-firewall.ps1"]) {
    entries.push([path.join(root, "src-tauri", "windows", name), name]);
  }
  for (const [source, target] of entries) {
    if (!fs.existsSync(source)) throw new Error(`Agent update input is missing: ${source}`);
    fs.mkdirSync(path.dirname(path.join(destination, target)), { recursive: true });
    fs.cpSync(source, path.join(destination, target), { recursive: true });
  }
}

export function buildAgentFileUpdate(root, targetRelease, version) {
  const stage = fs.mkdtempSync(path.join(targetRelease, "agent-file-update-"));
  const payload = path.join(stage, "payload");
  const output = path.join(targetRelease, "bundle", "nsis", "WonRemote-Agent-Update.exe");
  const compiler = path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "makensis.exe");
  if (!fs.existsSync(compiler)) throw new Error("The existing Tauri NSIS compiler is required for Agent file updates.");
  try {
    stageAgentFileUpdate(root, path.join(targetRelease, "wonremote-viewer.exe"), payload);
    const host = path.join(payload, "wonremote-viewer.exe");
    fs.writeFileSync(host, nsisHostBytes(fs.readFileSync(host)));
    execFileSync(compiler, ["/V2", `/DUPDATE_OUTPUT=${output}`, `/DUPDATE_VERSION=${version}`,
      `/DUPDATE_PAYLOAD=${payload}`, path.join(root, "src-tauri", "windows", "agent-file-update.nsi")],
    { cwd: root, stdio: "inherit", windowsHide: true });
    return output;
  } finally {
    // mkdtemp returns an owned child of this exact build directory.
    if (path.dirname(stage) !== path.resolve(targetRelease)) throw new Error("Unsafe Agent update staging cleanup.");
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
