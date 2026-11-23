import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { loadProductionInstallerUpdateMetadata, loadProductionRollbackMetadata } from "../agent/productionUpdateMetadata";
import { downloadInstallerUpdate } from "../agent/productionInstallerUpdate";

const projectRoot = path.resolve(__dirname, "..", "..");
const manifestScript = path.join(projectRoot, "scripts", "create-update-manifest.js");

function fixtureFiles(root: string) {
  const files = {
    viewer: path.join(root, "WonRemote-Viewer-Setup.exe"),
    agent: path.join(root, "WonRemote-Agent-Setup.exe"),
    update: path.join(root, "WonRemote-Agent-Update.exe"),
  };
  for (const [name, file] of Object.entries(files)) {
    writeFileSync(file, `${name}-bytes`);
  }
  return files;
}

function manifestReaderAt(revision: string) {
  const source = execFileSync("git", ["show", revision + ":aether-link-app/src/domain/updateManifest.ts"],
    { cwd: projectRoot, encoding: "utf8" });
  const legacyModule = { exports: {} as {
    parseProductionUpdateManifest: (manifest: unknown, options: unknown) => { latestVersion: string; assetName: string };
  } };
  runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code,
    { module: legacyModule, exports: legacyModule.exports, require: createRequire(import.meta.url), Buffer, URL });
  return legacyModule.exports.parseProductionUpdateManifest;
}

describe("production update manifest scripts", () => {
  it("signs optional Agent arguments, verifies the release and reaches the installer downloader", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-signed-args-"));
    try {
      const files = fixtureFiles(root);
      const out = path.join(root, "manifest.json");
      const key = path.join(root, "private.pem");
      const publicKey = path.join(root, "public.pem");
      const installerArgs = ["/S", "/UPDATE"];
      execFileSync(process.execPath, [path.join(projectRoot, "scripts/generate-update-keypair.js"),
        "--private-key", key, "--public-key", publicKey], { cwd: projectRoot });
      const generateArgs = [
        manifestScript, "--viewer-x64", files.viewer, "--agent-x64", files.agent,
        "--agent-update-x64", files.update, "--version", "0.1.124", "--private-key", key, "--out", out,
      ];
      execFileSync(process.execPath, [...generateArgs, "--agent-installer-args", JSON.stringify(installerArgs)], { cwd: projectRoot });
      const manifest = JSON.parse(readFileSync(out, "utf8"));
      for (const arch of ["x64", "x86"]) {
        expect(manifest.viewerWindows[arch]).not.toHaveProperty("installerArgs");
        expect(manifest.agentInstallers[arch].installerArgs).toEqual(installerArgs);
        expect(manifest.agentWindows[arch]).toEqual(manifest.agentInstallers[arch]);
        expect(manifest.agentFileUpdates[arch].installerArgs).toEqual(installerArgs);
      }
      const publicKeyPem = readFileSync(publicKey, "utf8");
      const verify = () => execFileSync(process.execPath, [
        path.join(projectRoot, "scripts/verify-release-manifest.js"), "--manifest", out,
        "--version", "0.1.124", "--viewer-x64", files.viewer, "--agent-x64", files.agent, "--agent-update-x64", files.update,
      ], {
        cwd: projectRoot,
        env: { ...process.env, WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKeyPem },
        stdio: "pipe",
      });
      verify();
      const parse123 = manifestReaderAt("10cd3d35575ba5605b82e320238d05f0f8de5575");
      expect(() => parse123(manifest, { arch: "x86", product: "agent", publicKeyPem })).toThrow(/v2 signature verification failed/);
      expect(parse123(manifest, { arch: "x86", product: "viewer", publicKeyPem }).assetName).toBe("WonRemote-Viewer-Setup.exe");
      const metadata = await loadProductionInstallerUpdateMetadata({
        WONREMOTE_BUILD_ARCH: "x86",
        WONREMOTE_AGENT_FILE_UPDATE: "1",
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKeyPem,
      }, async () => new Response(JSON.stringify(manifest)));
      expect(metadata?.assetName).toBe("WonRemote-Agent-Update.exe");
      expect(await downloadInstallerUpdate(metadata!, { baseDir: root, fetchImpl: async () => new Response(readFileSync(files.update)) }))
        .toMatchObject({ installerArgs });
      delete manifest.agentFileUpdates.x86.installerArgs;
      writeFileSync(out, JSON.stringify(manifest));
      expect(verify).toThrow(/signatureV2/);
      expect(() => execFileSync(process.execPath, [
        ...generateArgs, "--agent-installer-args", JSON.stringify(["/S", "/FIRSTHOP=C:\\manifest.json"]),
      ], { cwd: projectRoot, stdio: "pipe" })).toThrow(/installer argument/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signs and verifies a Viewer-only release without reading or publishing Agent assets",()=>{
    const root=mkdtempSync(path.join(tmpdir(),"wonremote-viewer-manifest-"));
    try{
      const viewer=path.join(root,"WonRemote-Viewer-Setup.exe"),out=path.join(root,"manifest.json"),key=path.join(root,"private.pem"),publicKey=path.join(root,"public.pem");
      writeFileSync(viewer,"viewer122bytes");
      execFileSync(process.execPath,[path.join(projectRoot,"scripts/generate-update-keypair.js"),`--private-key=${key}`,`--public-key=${publicKey}`],{cwd:projectRoot});
      execFileSync(process.execPath,[manifestScript,"--viewer-only=true",`--viewer-x64=${viewer}`,`--agent-x64=${path.join(root,"absent-agent.exe")}`,`--agent-update-x64=${path.join(root,"absent-update.exe")}`,"--version=0.1.122",`--private-key=${key}`,`--out=${out}`],{cwd:projectRoot});
      const manifest=JSON.parse(readFileSync(out,"utf8"));
      expect(manifest.version).toBe("0.1.122");expect(manifest.agentWindows).toBeUndefined();expect(manifest.agentInstallers).toBeUndefined();expect(manifest.agentFileUpdates).toBeUndefined();
      expect(manifest.viewerWindows.x86.url).toContain("/v0.1.122/WonRemote-Viewer-Setup.exe");
      execFileSync(process.execPath,[path.join(projectRoot,"scripts/verify-release-manifest.js"),"--viewer-only","true","--manifest",out,"--version","0.1.122","--viewer-x64",viewer],{cwd:projectRoot,env:{...process.env,WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY:readFileSync(publicKey,"utf8")}});
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it("signs file-only Agent updates separately from first-install Setup for old and current readers", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-manifest-contract-"));
    try {
      const files = fixtureFiles(root);
      const out = path.join(root, "wonremote-update-manifest.json");
      const key = path.join(root, "private.pem");
      const publicKey = path.join(root, "public.pem");
      execFileSync(process.execPath, [path.join(projectRoot, "scripts", "generate-update-keypair.js"), `--private-key=${key}`, `--public-key=${publicKey}`], { cwd: projectRoot });
      execFileSync(process.execPath, [
        manifestScript,
        `--viewer-x64=${files.viewer}`,
        `--agent-x64=${files.agent}`,
        `--agent-update-x64=${files.update}`,
        "--version=9.9.9",
        `--private-key=${key}`,
        `--out=${out}`,
      ], { cwd: projectRoot });
      const manifest = JSON.parse(readFileSync(out, "utf8"));
      expect(manifest.viewerWindows.x64.name).toBe("WonRemote-Viewer-Setup.exe");
      expect(manifest.viewerWindows.x86.name).toBe("WonRemote-Viewer-Setup.exe");
      expect(manifest.agentWindows.x64.name).toBe("WonRemote-Agent-Setup.exe");
      expect(manifest.agentWindows.x86.name).toBe("WonRemote-Agent-Setup.exe");
      expect(manifest.agentInstallers.x86.name).toBe("WonRemote-Agent-Setup.exe");
      expect(manifest.agentWindows).toEqual(manifest.agentInstallers);
      expect(manifest.agentFileUpdates.x86.name).toBe("WonRemote-Agent-Update.exe");
      expect(manifest.agentFileUpdates.x86.sha256).not.toBe(manifest.agentWindows.x86.sha256);
      expect(manifest.architectureMigration).toBeUndefined();
      expect(manifest.windows).toEqual(manifest.viewerWindows);
      expect(manifest.viewerWindows.x64.url).toContain("/download/v9.9.9/");
      expect(manifest.viewerWindows.x64.url).not.toContain("latest/download");
      // Run the actual 0.1.88 reader, not today's parser posing as a legacy client.
      const parse88 = manifestReaderAt("04cb8336253e5d102bdd9f58af69ae19b4f7e1a5");
      for (const product of ["agent", "viewer"]) {
        for (const arch of ["x86", "x64"]) {
          const options = { product, arch, publicKeyPem: readFileSync(publicKey, "utf8") };
          expect(parse88(manifest, options)).toMatchObject({
            latestVersion: "9.9.9", assetName: product === "agent" ? "WonRemote-Agent-Setup.exe" : "WonRemote-Viewer-Setup.exe",
          });
          expect(() => parse88({ ...manifest, version: "9.9.10" }, options)).toThrow();
        }
      }
      execFileSync(process.execPath, [
        path.join(projectRoot, "scripts", "verify-release-manifest.js"),
        "--manifest", out,
        "--version", "9.9.9",
        "--viewer-x64", files.viewer,
        "--agent-x64", files.agent,
        "--agent-update-x64", files.update,
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: readFileSync(publicKey, "utf8"),
        },
      });
      const env = { WONREMOTE_UPDATE_PRODUCT: "agent", WONREMOTE_BUILD_ARCH: "x86",
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: readFileSync(publicKey, "utf8") };
      const rollback = await loadProductionRollbackMetadata("9.9.9", "9.9.10", env,
        async () => new Response(JSON.stringify(manifest)));
      expect(rollback.assetName).toBe("WonRemote-Agent-Setup.exe");
      expect(rollback.downloadUrl).toContain("/download/v9.9.9/WonRemote-Agent-Setup.exe");
      await expect(loadProductionRollbackMetadata("9.9.9", "9.9.10", env,
        async () => new Response(JSON.stringify({ ...manifest, agentInstallers: { x86: { ...manifest.agentInstallers.x86, sha256: "0".repeat(64) } } }))))
        .rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when either required product installer input is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-manifest-missing-"));
    try {
      const files = fixtureFiles(root);
      rmSync(files.agent);
      expect(() => execFileSync(process.execPath, [manifestScript, `--viewer-x64=${files.viewer}`, `--agent-x64=${files.agent}`, "--version=9.9.9", `--out=${path.join(root, "out.json")}`], { cwd: projectRoot })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to generate update metadata without a separate file updater", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wonremote-file-update-missing-"));
    try {
      const files = fixtureFiles(root);
      rmSync(files.update);
      expect(() => execFileSync(process.execPath, [manifestScript, `--viewer-x64=${files.viewer}`, `--agent-x64=${files.agent}`,
        `--agent-update-x64=${files.update}`, `--out=${path.join(root, "out.json")}`], { cwd: projectRoot, stdio: "pipe" })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("publishes two x86 installers, the file update and one manifest after the draft gate", () => {
    const script = readFileSync(path.join(projectRoot, "scripts", "publish-github-release.ps1"), "utf8");
    expect(script).toContain("$PublishedAssets = @(foreach ($ExpectedAsset in $ExpectedAssets)");
    expect(script).toContain("draft = $true");
    expect(script).toContain("draft = $false");
    for(const field of ["StableInstallerAssetName","StableAgentInstallerAssetName","AgentFileUpdateAssetName","ManifestName"])expect(script).toContain(`Name = $${field}`);
    expect(script).not.toContain("Portable");
    expect(script).not.toContain("_${Version}_");
  });
  (process.platform==='win32'?it:it.skip)("executes the publisher asset plan for both products and Viewer-only without changing global latest",()=>{
    const root=mkdtempSync(path.join(tmpdir(),'wonremote-publish-scope-'));
    try{
      const script=readFileSync(path.join(projectRoot,'scripts/publish-github-release.ps1'),'utf8');
      const plan=script.slice(script.indexOf('$ExpectedAssets = @('),script.indexOf('function Assert-Manifest'));
      const run=(viewerOnly:boolean)=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';$ViewerOnly=$${viewerOnly};$ReleaseDir='${root.replace(/'/g,"''")}';$StableInstallerAssetName='WonRemote-Viewer-Setup.exe';$StableAgentInstallerAssetName='WonRemote-Agent-Setup.exe';$AgentFileUpdateAssetName='WonRemote-Agent-Update.exe';$ManifestName='wonremote-update-manifest.json';$StableInstallerPath='viewer';$StableAgentInstallerPath='agent';$AgentFileUpdatePath='update';$ManifestPath='manifest';${plan};$ExpectedAssets|ConvertTo-Json -Compress`],{encoding:'utf8'}));
      expect(run(false).map((asset:any)=>asset.Name)).toEqual(['WonRemote-Viewer-Setup.exe','WonRemote-Agent-Setup.exe','WonRemote-Agent-Update.exe','wonremote-update-manifest.json']);
      expect(run(true).map((asset:any)=>asset.Name)).toEqual(['WonRemote-Viewer-Setup.exe','wonremote-update-manifest.json']);
      expect(script).toContain("make_latest = $(if ($ViewerOnly) { 'false' } else { 'true' })");
      writeFileSync(path.join(root,'WonRemote-Agent-Setup.exe'),'wrong-scope');
      expect(()=>run(true)).toThrow();
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
