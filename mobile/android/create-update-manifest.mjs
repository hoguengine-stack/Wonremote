import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, renameSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const products = [
  ["agent", "Agent", "com.wonremote.agent"],
  ["viewer", "Viewer", "com.wonremote.viewer"],
  ["control-addon", "Control-Addon", "com.wonremote.controladdon"],
];
const hash = (value) => createHash("sha256").update(value).digest("hex");

function verifyZip(zipPath, apkPath) {
  const filename = path.basename(apkPath);
  const options = { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 * 1024 };
  const entries = execFileSync("tar", ["-tf", zipPath], options).toString().trim().split(/\r?\n/);
  if (entries.length !== 1 || entries[0] !== filename) throw new Error("Unexpected Android ZIP contents");
  const payload = execFileSync("tar", ["-xOf", zipPath, filename], options);
  if (!payload.equals(readFileSync(apkPath))) throw new Error("Android ZIP contains a different APK");
}

export function verifyAndroidManifest(repo) {
  const app = path.join(repo, "aether-link-app");
  const download = path.join(app, "public/download");
  if (!products.some(([key]) => existsSync(path.join(download, key + ".zip")))) return;
  const manifest = JSON.parse(readFileSync(path.join(download, "android-update.json"), "utf8"));
  const { version } = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
  const [major, minor, patch] = version.split(".").map(Number);
  const code = major * 1_000_000 + minor * 1000 + patch;
  if (manifest.schemaVersion !== 1 || Object.keys(manifest.apps).length !== 3)
    throw new Error("Android update manifest must include all three apps");
  for (const [key, name, id] of products) {
    const release = manifest.apps[id];
    const expected = "https://wonremote-a7fd3.web.app/download/android/v" + version + "/" + key + ".zip";
    if (!release || release.versionName !== version || release.versionCode !== code || release.url !== expected)
      throw new Error("Android update manifest version/package mismatch: " + id);
    const apk = readFileSync(path.join(app, "release-apk", "WonRemote-" + name + ".apk"));
    const zip = readFileSync(path.join(download, "android", "v" + version, key + ".zip"));
    const alias = readFileSync(path.join(download, key + ".zip"));
    if (hash(apk) !== release.apkSha256 || apk.length !== release.apkSize
      || hash(zip) !== release.zipSha256 || zip.length !== release.zipSize || !zip.equals(alias))
      throw new Error("Android update payload/hash mismatch: " + id);
    verifyZip(path.join(download, "android", "v" + version, key + ".zip"),
      path.join(app, "release-apk", "WonRemote-" + name + ".apk"));
  }
}

export function publishAndroidManifest(repo, inspectApk) {
  const app = path.join(repo, "aether-link-app");
  const { version } = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 999))
    throw new Error("Invalid Android release version");
  const code = parts[0] * 1_000_000 + parts[1] * 1000 + parts[2];
  const download = path.join(app, "public", "download");
  const entries = products.map(([key, name, packageId]) => {
    const apkPath = path.join(app, "release-apk", `WonRemote-${name}.apk`);
    const zipPath = path.join(download, `${key}.zip`);
    const apk = readFileSync(apkPath);
    const zip = readFileSync(zipPath);
    const badging = inspectApk(apkPath);
    const packageLine = badging.split(/\r?\n/).find((line) => line.startsWith("package:")) ?? "";
    const attr = (name) => packageLine.match(new RegExp(name + "='([^']+)'"))?.[1];
    if (attr("name") !== packageId || Number(attr("versionCode")) !== code || attr("versionName") !== version)
      throw new Error(`Stale or wrong Android APK: ${name}`);
    if (apk.length < 1 || zip.length < 1) throw new Error("Empty Android artifact");
    verifyZip(zipPath, apkPath);
    return { key, zipPath, packageId, data: {
      versionName: version, versionCode: code,
      url: `https://wonremote-a7fd3.web.app/download/android/v${version}/${key}.zip`,
      apkSha256: hash(apk), apkSize: apk.length, zipSha256: hash(zip), zipSize: zip.length,
    }};
  });
  // Publish the discovery file only after every product has validated metadata and bytes.
  const versionDir = path.join(download, "android", `v${version}`);
  for (const { key, zipPath } of entries) {
    const previous = path.join(versionDir, key + ".zip");
    if (existsSync(previous) && !readFileSync(previous).equals(readFileSync(zipPath)))
      throw new Error("Android release version is immutable; bump the version before rebuilding");
  }
  mkdirSync(versionDir, { recursive: true });
  for (const { key, zipPath } of entries) copyFileSync(zipPath, path.join(versionDir, `${key}.zip`));
  const manifest = { schemaVersion: 1, apps: Object.fromEntries(entries.map(e => [e.packageId, e.data])) };
  const output = path.join(download, "android-update.json");
  writeFileSync(output + ".tmp", JSON.stringify(manifest, null, 2) + "\n");
  renameSync(output + ".tmp", output);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (process.argv[2] === "--verify") {
    verifyAndroidManifest(repo);
    console.log("Android update payloads and discovery metadata verified");
  } else {
  const aapt = process.argv[2];
  if (!aapt) throw new Error("Android SDK aapt path is required");
  const result = publishAndroidManifest(repo,
    apk => execFileSync(aapt, ["dump", "badging", apk], { encoding: "utf8", windowsHide: true }));
  console.log("Android update manifest verified for", Object.keys(result.apps).join(", "));
  }
}
