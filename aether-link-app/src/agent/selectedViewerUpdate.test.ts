import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildProductionUpdateSignaturePayload, buildProductionUpdateSignaturePayloadV2 } from "../domain/updateManifest";
import { loadSelectedViewerUpdate, selectedViewerPolicyPayload } from "./selectedViewerUpdate";
function fixture() {
  const keys=generateKeyPairSync("ed25519");
  const data={arch:"x86" as const,assetName:"WonRemote-Viewer-Setup.exe",checksum:"a".repeat(64),downloadUrl:"https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.94/WonRemote-Viewer-Setup.exe",latestVersion:"0.1.94",forceUpdate:true,updateKind:"installer" as const};
  const signature=(text:string)=>sign(null,Buffer.from(text),keys.privateKey).toString("base64");
  const payload={product:"viewer",enabled:true,targetInstallIds:["59F19451"],expiresAt:new Date(Date.now()+86400000).toISOString(),manifest:{version:data.latestVersion,forceUpdate:true,viewerWindows:{x86:{name:data.assetName,sha256:data.checksum,url:data.downloadUrl,signature:signature(buildProductionUpdateSignaturePayload(data)),signatureV2:signature(buildProductionUpdateSignaturePayloadV2(data))}}}};
  const envelope={payload,signature:signature(selectedViewerPolicyPayload(payload))};
  const env={WONREMOTE_UPDATE_PRODUCT:"viewer",WONREMOTE_VIEWER_INSTALL_ID:"59F19451",WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY:keys.publicKey.export({format:"pem",type:"spki"}).toString()};
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(envelope)));
  return {env,envelope,fetcher};
}
it("allows only signed selected identity and never forces downgrade",async()=>{
  const f=fixture();
  expect(await loadSelectedViewerUpdate(f.env,f.fetcher)).toMatchObject({latestVersion:"0.1.94",forceUpdate:false});
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(await loadSelectedViewerUpdate({...f.env,WONREMOTE_VIEWER_INSTALL_ID:"82220F6D"},f.fetcher)).toBeNull();
});
it("rejects tampered targeting, expired policy and wrong installer signature",async()=>{
  for(const kind of ["target","expiry","asset"]) {
    const f=fixture();
    if(kind==="target") f.envelope.payload.targetInstallIds.push("82220F6D");
    if(kind==="expiry") { await expect(loadSelectedViewerUpdate(f.env,f.fetcher,Date.now()+2*86400000)).rejects.toThrow(); continue; }
    if(kind==="asset") f.envelope.payload.manifest.viewerWindows.x86.sha256="b".repeat(64);
    await expect(loadSelectedViewerUpdate(f.env,f.fetcher)).rejects.toThrow("signature");
  }
});
it("does not fetch for missing identity or Agent, and does not fall back on404",async()=>{
  const f=fixture();
  expect(await loadSelectedViewerUpdate({...f.env,WONREMOTE_VIEWER_INSTALL_ID:""},f.fetcher)).toBeNull();
  expect(await loadSelectedViewerUpdate({...f.env,WONREMOTE_UPDATE_PRODUCT:"agent"},f.fetcher)).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
  const missing=vi.fn(async()=>new Response("",{status:404}));
  expect(await loadSelectedViewerUpdate(f.env,missing)).toBeNull(); expect(missing).toHaveBeenCalledTimes(1);
});
it("stops reading and cancels oversized policy instead of buffering the full response",async()=>{
  const f=fixture(); let pulls=0; const cancel=vi.fn();
  const body=new ReadableStream<Uint8Array>({
    pull(controller){ pulls++; if(pulls<=4) controller.enqueue(new Uint8Array(32768).fill(32)); else controller.close(); },
    cancel,
  },{highWaterMark:0});
  await expect(loadSelectedViewerUpdate(f.env,async()=>new Response(body))).rejects.toThrow("too large");
  expect(pulls).toBe(3); expect(cancel).toHaveBeenCalledOnce();
});
it("accepts a valid signed policy exactly at the byte limit",async()=>{
  const f=fixture(); const json=JSON.stringify(f.envelope);
  const body=json+' '.repeat(65536-Buffer.byteLength(json));
  expect(await loadSelectedViewerUpdate(f.env,async()=>new Response(body))).toMatchObject({latestVersion:"0.1.94"});
});
