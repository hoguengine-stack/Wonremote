import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Standalone Node release script.
import { publishAndroidManifest, verifyAndroidManifest, verifyAndroidHostingArtifacts,verifyPublishedAndroidHistory } from "../../mobile/android/create-update-manifest.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wonremote-update-"));
  roots.push(root);
  const app = path.join(root, "aether-link-app");
  mkdirSync(path.join(app, "release-apk"), { recursive: true });
  mkdirSync(path.join(app, "public/download"), { recursive: true });
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ version: "0.1.81" }));
  for (const [key, name] of [["agent", "Agent"], ["viewer", "Viewer"], ["control-addon", "Control-Addon"]]) {
    writeFileSync(path.join(app, "release-apk", `WonRemote-${name}.apk`), name);
    execFileSync("tar", ["-acf", path.join(app, "public/download", `${key}.zip`),
      "-C", path.join(app, "release-apk"), `WonRemote-${name}.apk`], { windowsHide: true });
  }
  const inspect = (file: string) => {
    const name = file.includes("Control-Addon") ? "controladdon" : file.includes("Viewer") ? "viewer" : "agent";
    return `package: name='com.wonremote.${name}' versionCode='1081' versionName='0.1.81' platformBuildVersionName='15'`;
  };
  return { root, app, inspect };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
describe("Android release discovery", () => {
  (process.platform==='win32'?it:it.skip)("passes a complete Gradle Viewer task and scope flag instead of splatting characters",()=>{
    const script=readFileSync(path.resolve(__dirname,'../../mobile/android/build-agent-release.ps1'),'utf8');
    const task=script.split(/\r?\n/).filter(line=>line.includes('$Tasks =')||line.includes('& .\\gradlew.bat @Tasks')).join('\n').replace('& .\\gradlew.bat','Invoke-Fixture');
    const flag=script.split(/\r?\n/).find(line=>line.startsWith('$ScopeArgs ='));
    const run=(value:boolean,body:string)=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ViewerOnly=$${value};function Invoke-Fixture { ConvertTo-Json -InputObject @($args) -Compress };${body}`],{encoding:'utf8'}));
    expect(run(true,task)).toEqual([':viewer:assembleRelease','--build-cache','--parallel']);
    expect(run(false,task)).toEqual([':agent:assembleRelease',':viewer:assembleRelease',':controladdon:assembleRelease','--build-cache','--parallel']);
    expect(run(true,`${flag};Invoke-Fixture @ScopeArgs`)).toEqual(['--viewer-only']);
  });
  it("updates only Android Viewer while preserving signed Agent and add-on discovery and payloads",()=>{
    const {root,app,inspect}=fixture();const previous=publishAndroidManifest(root,inspect);
    writeFileSync(path.join(app,'package.json'),JSON.stringify({version:'0.1.82'}));
    writeFileSync(path.join(app,'release-apk/WonRemote-Viewer.apk'),'new-viewer');
    execFileSync('tar',['-acf',path.join(app,'public/download/viewer.zip'),'-C',path.join(app,'release-apk'),'WonRemote-Viewer.apk']);
    const current=(file:string)=>file.includes('Viewer')?inspect(file).replace('1081','1082').replace('0.1.81','0.1.82'):inspect(file);
    const manifest=publishAndroidManifest(root,current,{viewerOnly:true});
    expect(manifest.apps['com.wonremote.viewer'].versionName).toBe('0.1.82');
    for(const id of ['com.wonremote.agent','com.wonremote.controladdon'])expect(manifest.apps[id]).toEqual(previous.apps[id]);
    expect(()=>verifyAndroidManifest(root,{viewerOnly:true})).not.toThrow();
    expect(()=>verifyAndroidManifest(root)).toThrow('version/package mismatch');
    cpSync(path.join(app,'public/download'),path.join(app,'dist/download'),{recursive:true});
    expect(()=>verifyAndroidHostingArtifacts(root,{viewerOnly:true})).not.toThrow();
    writeFileSync(path.join(app,'public/download/agent.zip'),'tampered');
    expect(()=>verifyAndroidManifest(root,{viewerOnly:true})).toThrow('payload/hash mismatch');
  });
  it("blocks removal or changed bytes of currently published versioned archives before Hosting deploy",async()=>{
    const {root,app,inspect}=fixture();const live=publishAndroidManifest(root,inspect);
    const load=async()=>live;
    await expect(verifyPublishedAndroidHistory(root,load)).rejects.toThrow("Missing published Android archive");
    cpSync(path.join(app,"public/download"),path.join(app,"dist/download"),{recursive:true});
    await expect(verifyPublishedAndroidHistory(root,load)).resolves.toBeUndefined();
    writeFileSync(path.join(app,"dist/download/android/v0.1.81/agent.zip"),"bad");
    await expect(verifyPublishedAndroidHistory(root,load)).rejects.toThrow("Changed published Android archive");
    const invalid=structuredClone(live);invalid.apps['com.wonremote.agent'].url='https://other.invalid/file.zip';
    await expect(verifyPublishedAndroidHistory(root,async()=>invalid)).rejects.toThrow("Invalid published Android archive");
  });
  it("blocks stale or missing Hosting copies even when public APK metadata passes", () => {
    const { root, app, inspect } = fixture();
    publishAndroidManifest(root, inspect);
    expect(() => verifyAndroidHostingArtifacts(root)).toThrow("Stale Android Hosting artifact");
    const hosted = path.join(app, "dist/download");
    cpSync(path.join(app, "public/download"), hosted, { recursive: true });
    expect(() => verifyAndroidHostingArtifacts(root)).not.toThrow();
    for (const file of ["android-update.json", "viewer.zip", "android/v0.1.81/viewer.zip"]) {
      const target = path.join(hosted, file);
      const original = readFileSync(target);
      writeFileSync(target, "old hosting output");
      expect(() => verifyAndroidManifest(root)).not.toThrow();
      expect(() => verifyAndroidHostingArtifacts(root)).toThrow("Stale Android Hosting artifact");
      writeFileSync(target, original);
    }
  });
  it.each(["0.1.103", "0.1.111"])("publishes %s as newer discovery for old Viewer installs", (version) => {
    const { root, app, inspect } = fixture();
    const code = 1000 + Number(version.split(".")[2]);
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ version }));
    const manifest = publishAndroidManifest(root, (file: string) =>
      inspect(file).replace("1081", String(code)).replace("0.1.81", version));
    const viewer = manifest.apps["com.wonremote.viewer"];
    expect(viewer.versionCode).toBe(code);
    expect(viewer.versionCode).toBeGreaterThan(1093);
    if (version === "0.1.111") expect(viewer.versionCode).toBeGreaterThan(1103);
    expect(viewer.versionName).toBe(version);
    expect(viewer.url).toContain(`/android/v${version}/viewer.zip`);
    expect(() => verifyAndroidManifest(root)).not.toThrow();
  });
  it("publishes all three actual package versions and hashes with versioned payload URLs", () => {
    const { root, app, inspect } = fixture();
    const manifest = publishAndroidManifest(root, inspect);
    expect(Object.keys(manifest.apps)).toHaveLength(3);
    for (const release of Object.values(manifest.apps) as any[]) {
      expect(release.versionCode).toBe(1081);
      const local = path.join(app, "public", new URL(release.url).pathname);
      const bytes = readFileSync(local);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(release.zipSha256);
    }
    expect(JSON.parse(readFileSync(path.join(app, "public/download/android-update.json"), "utf8"))).toEqual(manifest);
    expect(() => verifyAndroidManifest(root)).not.toThrow();
  });
  it("does not announce a new version if one of three built APKs is stale", () => {
    const { root, app, inspect } = fixture();
    expect(() => publishAndroidManifest(root, (file: string) =>
      inspect(file).replace(file.includes("Viewer") ? "1081" : "unused", "1080")
    )).toThrow("Stale or wrong");
    expect(existsSync(path.join(app, "public/download/android-update.json"))).toBe(false);
  });
  it("rejects a wrong package and preserves previous discovery metadata", () => {
    const { root, app, inspect } = fixture();
    publishAndroidManifest(root, inspect);
    const filename = path.join(app, "public/download/android-update.json");
    const before = readFileSync(filename, "utf8");
    expect(() => publishAndroidManifest(root, (file: string) => inspect(file).replace("com.wonremote", "com.other")))
      .toThrow("Stale or wrong");
    expect(readFileSync(filename, "utf8")).toBe(before);
  });
  it("all three native launch activities share the updater without importing accessibility into Viewer", () => {
    const repo = path.resolve(__dirname, "../..");
    for (const [module, pkg] of [["agent", "agent"], ["viewer", "viewer"], ["controladdon", "controladdon"]]) {
      const source = readFileSync(path.join(repo, `mobile/android/${module}/src/main/java/com/wonremote/${pkg}/MainActivity.java`), "utf8");
      expect(source).toContain("extends com.wonremote.update.UpdateActivity");
      expect(source).toContain("updateButton()");
    }
    const viewer = readFileSync(path.join(repo, "mobile/android/viewer/build.gradle.kts"), "utf8");
    expect(viewer).toContain('project(":updatecore")');
    expect(viewer).not.toContain('project(":controlcore")');
  });
  it("blocks deployment when APK downloads exist without update discovery or have changed bytes", () => {
    const { root, app, inspect } = fixture();
    expect(() => verifyAndroidManifest(root)).toThrow();
    publishAndroidManifest(root, inspect);
    writeFileSync(path.join(app, "public/download/agent.zip"), "wrong release");
    expect(() => verifyAndroidManifest(root)).toThrow("payload/hash mismatch");
  });
  it("blocks a PC version bump from announcing stale Android APKs", () => {
    const { root, app, inspect } = fixture();
    publishAndroidManifest(root, inspect);
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ version: "0.1.82" }));
    expect(() => verifyAndroidManifest(root)).toThrow("version/package mismatch");
  });
  it("never overwrites an already published version with different ZIP bytes", () => {
    const { root, app, inspect } = fixture();
    publishAndroidManifest(root, inspect);
    const file = path.join(app, "public/download/android-update.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(path.join(app, "release-apk/WonRemote-Agent.apk"), "new bytes");
    execFileSync("tar", ["-acf", path.join(app, "public/download/agent.zip"),
      "-C", path.join(app, "release-apk"), "WonRemote-Agent.apk"], { windowsHide: true });
    expect(() => publishAndroidManifest(root, inspect)).toThrow("immutable");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("rejects an old APK inside a ZIP even when the standalone APK metadata is current", () => {
    const { root, app, inspect } = fixture();
    writeFileSync(path.join(app, "release-apk/WonRemote-Agent.apk"), "new APK");
    expect(() => publishAndroidManifest(root, inspect)).toThrow("different APK");
    expect(existsSync(path.join(app, "public/download/android-update.json"))).toBe(false);
  });
});
