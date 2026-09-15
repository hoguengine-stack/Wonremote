import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSelectedViewerPolicy } from "./create-selected-viewer-policy";
import { loadSelectedViewerUpdate } from "../src/agent/selectedViewerUpdate";
import { buildProductionUpdateSignaturePayload, buildProductionUpdateSignaturePayloadV2 } from "../src/domain/updateManifest";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const data = { arch: "x86" as const, assetName: "WonRemote-Viewer-Setup.exe", checksum: "a".repeat(64), downloadUrl: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.94/WonRemote-Viewer-Setup.exe", latestVersion: "0.1.94", forceUpdate: false, updateKind: "installer" as const };
  const signature = (text:string) => sign(null, Buffer.from(text), keys.privateKey).toString("base64");
  const manifest = { version: data.latestVersion, viewerWindows: { x86: { name: data.assetName, sha256: data.checksum, url: data.downloadUrl, signature: signature(buildProductionUpdateSignaturePayload(data)), signatureV2: signature(buildProductionUpdateSignaturePayloadV2(data)) } } };
  return {
    env: { WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: keys.publicKey.export({format:"pem",type:"spki"}).toString(), WONREMOTE_UPDATE_PRODUCT:"viewer", WONREMOTE_VIEWER_INSTALL_ID:"59F19451" },
    input: { manifest, targets: ["59f19451", "59F19451"], expiresAt: new Date(Date.now()+86400000).toISOString(), privateKey: keys.privateKey.export({format:"pem",type:"pkcs8"}).toString() },
  };
}
it("generates a policy accepted by the actual client for selected targets only", async () => {
  const f=fixture(); const policy=await createSelectedViewerPolicy(f.input,f.env);
  expect(policy.payload.targetInstallIds).toEqual(["59F19451"]);
  const fetcher=async()=>new Response(JSON.stringify(policy));
  expect(await loadSelectedViewerUpdate(f.env,fetcher)).toMatchObject({latestVersion:"0.1.94",forceUpdate:false});
  expect(await loadSelectedViewerUpdate({...f.env,WONREMOTE_VIEWER_INSTALL_ID:"82220F6D"},fetcher)).toBeNull();
  expect(JSON.stringify(policy)).not.toContain("PRIVATE KEY");
});
it("creates a signed disable policy without bypassing installer validation", async () => {
  const f=fixture(); const policy=await createSelectedViewerPolicy({...f.input,enabled:false},f.env);
  expect(await loadSelectedViewerUpdate(f.env,async()=>new Response(JSON.stringify(policy)))).toBeNull();
  f.input.manifest.viewerWindows.x86.sha256="b".repeat(64);
  await expect(createSelectedViewerPolicy({...f.input,enabled:false},f.env)).rejects.toThrow();
});
it("rejects wildcard/empty targets, expiry, wrong signing key and tampered nested installer", async () => {
  for (const change of ["empty","wildcard","expiry","key","installer"]) {
    const f=fixture();
    if(change==="empty") f.input.targets=[];
    if(change==="wildcard") f.input.targets=["*"];
    if(change==="expiry") f.input.expiresAt=new Date(0).toISOString();
    if(change==="key") f.input.privateKey=generateKeyPairSync("ed25519").privateKey.export({format:"pem",type:"pkcs8"}).toString();
    if(change==="installer") f.input.manifest.viewerWindows.x86.sha256="b".repeat(64);
    await expect(createSelectedViewerPolicy(f.input,f.env)).rejects.toThrow();
  }
});
it("CLI writes a verified local file and refuses to overwrite an existing policy", () => {
  const f=fixture(); const root=mkdtempSync(path.join(tmpdir(),"viewer-policy-"));
  try {
    const manifest=path.join(root,"manifest.json"); const output=path.join(root,"selected.json");
    writeFileSync(manifest,JSON.stringify(f.input.manifest));
    const args=[path.resolve("node_modules/tsx/dist/cli.mjs"),path.resolve("scripts/create-selected-viewer-policy.ts"),"--manifest",manifest,"--targets","59F19451","--expires",f.input.expiresAt,"--output",output];
    const options={env:{...process.env,...f.env,WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY:f.input.privateKey},windowsHide:true,encoding:"utf8" as const,stdio:"pipe" as const};
    expect(execFileSync(process.execPath,args,options)).toContain("Not published");
    const before=readFileSync(output,"utf8");
    expect(JSON.parse(before).payload.targetInstallIds).toEqual(["59F19451"]);
    expect(()=>execFileSync(process.execPath,args,options)).toThrow();
    expect(readFileSync(output,"utf8")).toBe(before);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
