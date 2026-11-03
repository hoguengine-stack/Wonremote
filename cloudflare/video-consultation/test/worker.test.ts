import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { cloudflareTurn } from "../src/turn";
import { verifyVideoViewer } from "../src/auth";
import { handleVideoRequest, VideoRooms, type Env } from "../src/worker";
import { limitedJson } from "../src/http";

const require=createRequire(import.meta.url),{build}=require("../../../aether-link-app/node_modules/esbuild");
const id="123e4567-e89b-42d3-a456-426614174000",project="wonremote-a7fd3",origin="https://wonremote-a7fd3.web.app";
const env={FIREBASE_PROJECT_ID:project,FIREBASE_WEB_API_KEY:"public-test-key",BOOTSTRAP_VIEWER_UID:"bootstrap",PUBLIC_ORIGIN:origin,
  VIDEO_INVITE_SECRET:"i".repeat(32),CLOUDFLARE_TURN_KEY_ID:"a".repeat(32),CLOUDFLARE_TURN_API_TOKEN:"server-only-key"};
const relay={iceServers:[{urls:["stun:stun.cloudflare.com:3478"]},{urls:["turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],username:"temporary-user",credential:"temporary-password"}]};
let pair:Awaited<ReturnType<typeof generateKeyPair>>,jwks:ReturnType<typeof createLocalJWKSet>,publicJwks:object;
async function signed(extra:Record<string,unknown>={},audience=project){
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({auth_time:now-5,wonremoteViewer:true,...extra}).setProtectedHeader({alg:"RS256",kid:"test-key"}).setSubject("viewer-1").setIssuedAt(now).setExpirationTime(now+600).setIssuer(`https://securetoken.google.com/${project}`).setAudience(audience).sign(pair.privateKey);
}
beforeAll(async()=>{pair=await generateKeyPair("RS256",{extractable:true});publicJwks={keys:[{...await exportJWK(pair.publicKey),kid:"test-key",alg:"RS256",use:"sig"}]};jwks=createLocalJWKSet(publicJwks);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe("Cloudflare video trust boundaries",()=>{
  it("owns stream timers, cleans cancellation/deadline/backpressure and stays idle without requests",async()=>{
    vi.useFakeTimers();
    const docs=new Map<string,unknown>();let reads=0,writes=0,alarm:number|null=null;
    const storage={get:async(key:string)=>{reads++;return structuredClone(docs.get(key));},put:async(key:string,value:unknown)=>{writes++;docs.set(key,structuredClone(value));},getAlarm:async()=>alarm,setAlarm:async(at:number)=>{alarm=at;},transaction:async(action:any)=>action(storage)};
    const fetcher=vi.fn(async()=>Response.json(relay));vi.stubGlobal("fetch",fetcher);
    try{
      const coordinator=new VideoRooms({storage} as any,env as Env);
      await vi.advanceTimersByTimeAsync(86_400_000);expect({reads,writes,requests:fetcher.mock.calls.length,timers:vi.getTimerCount()}).toEqual({reads:0,writes:0,requests:0,timers:0});
      const call=(action:string,expiresAt=Date.now()+3_600_000)=>coordinator.fetch(new Request("https://private/videoConsultation",{method:"POST",headers:{"X-Video-Owner":"viewer-1","X-Video-Auth-Expiry":String(expiresAt)},body:JSON.stringify({action,roomId:id,...(action==="signal"?{candidate:{candidate:"candidate:1",sdpMid:"0",sdpMLineIndex:0}}:{})})}));
      expect((await call("create")).status).toBe(200);
      const first=await call("watch"),reader=first.body!.getReader();await reader.read();
      expect(vi.getTimerCount()).toBe(2);await reader.cancel();expect(vi.getTimerCount()).toBe(0);
      const deadline=await call("watch",Date.now()+1000),timedReader=deadline.body!.getReader();await timedReader.read();const before={reads,writes,requests:fetcher.mock.calls.length};
      await vi.advanceTimersByTimeAsync(1000);expect(new TextDecoder().decode((await timedReader.read()).value)).toContain('"state":"ended"');expect(vi.getTimerCount()).toBe(0);expect({reads,writes,requests:fetcher.mock.calls.length}).toEqual(before);
      const blocked=await call("watch");await call("signal");await expect(blocked.body!.getReader().read()).rejects.toThrow("지연");expect(vi.getTimerCount()).toBe(0);
      const ended=await call("watch"),endedReader=ended.body!.getReader();await endedReader.read();await call("end");expect(new TextDecoder().decode((await endedReader.read()).value)).toContain('"state":"ended"');expect(vi.getTimerCount()).toBe(0);
      const idle={reads,writes,requests:fetcher.mock.calls.length};await vi.advanceTimersByTimeAsync(86_400_000);expect({reads,writes,requests:fetcher.mock.calls.length}).toEqual(idle);
    }finally{vi.unstubAllGlobals();}
  });
  it("requests only temporary credentials, validates relay response and never discloses server keys",async()=>{
    const send=vi.fn(async()=>Response.json(relay,{status:201}));
    const value=await cloudflareTurn(env.CLOUDFLARE_TURN_KEY_ID,env.CLOUDFLARE_TURN_API_TOKEN,send as typeof fetch);
    expect(value).toEqual({...relay,iceTransportPolicy:"all"});expect(JSON.stringify(value)).not.toContain(env.CLOUDFLARE_TURN_API_TOKEN);
    expect(send.mock.calls[0]).toMatchObject([`https://rtc.live.cloudflare.com/v1/turn/keys/${"a".repeat(32)}/credentials/generate-ice-servers`,{method:"POST",redirect:"manual",body:'{"ttl":3900}'}]);
    await expect(cloudflareTurn("",env.CLOUDFLARE_TURN_API_TOKEN,send as typeof fetch)).rejects.toMatchObject({status:412});expect(send).toHaveBeenCalledOnce();
    const alternative=await cloudflareTurn("a".repeat(32),"server-secret",async()=>Response.json({iceServers:[{...relay.iceServers[1],urls:["turn:turn.cloudflare.com:53?transport=udp",...relay.iceServers[1].urls]}]}));
    expect(alternative.iceServers[0].urls).toEqual(relay.iceServers[1].urls);
    for(const response of [new Response(null,{status:302,headers:{Location:"https://attacker.test"}}),new Response("secret-provider-error",{status:429}),Response.json({iceServers:[]}),Response.json({iceServers:[{urls:["turn:attacker.test:3478"],username:"u",credential:"c"}]}),new Response("x".repeat(17000))]){
      const fail=vi.fn(async()=>response);await expect(cloudflareTurn("a".repeat(32),"server-secret",fail as typeof fetch)).rejects.toMatchObject({status:503});expect(fail).toHaveBeenCalledOnce();
    }
  });
  it("checks real JWT signatures, project, Viewer role and current disabled/revoked state before admission",async()=>{
    const send=vi.fn(async()=>Response.json({users:[{localId:"viewer-1",validSince:"1"}]}));
    const token=await signed();await expect(verifyVideoViewer(`Bearer ${token}`,env,send as typeof fetch,jwks)).resolves.toMatchObject({uid:"viewer-1"});expect(send).toHaveBeenCalledOnce();
    for(const bad of ["not-a-token",await signed({},"another-project"),await signed({wonremoteViewer:false}),await signed({auth_time:Math.floor(Date.now()/1000)+100})])await expect(verifyVideoViewer(`Bearer ${bad}`,env,send as typeof fetch,jwks)).rejects.toBeInstanceOf(Error);
    expect(send).toHaveBeenCalledOnce();
    for(const user of [{localId:"viewer-1",validSince:"1",disabled:true},{localId:"viewer-1",validSince:String(Math.floor(Date.now()/1000)+1)},{localId:"other",validSince:"1"},{localId:"viewer-1"}]){
      await expect(verifyVideoViewer(`Bearer ${token}`,env,async()=>Response.json({users:[user]}),jwks)).rejects.toMatchObject({status:401});
    }
    await expect(verifyVideoViewer(`Bearer ${token}`,env,async()=>new Response("quota",{status:429}),jwks)).rejects.toMatchObject({status:503});
  });
  it("bounds streamed request bytes and rejects forged origins, methods, identity headers and token errors",async()=>{
    const cancel=vi.fn();let c:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start:value=>{c=value;},cancel});const read=limitedJson(body,3);c!.enqueue(new Uint8Array(4));await expect(read).rejects.toMatchObject({status:413});expect(cancel).toHaveBeenCalledOnce();
    const forward=vi.fn(async(request:Request)=>Response.json(Object.fromEntries(request.headers)));
    const configured={...env,VIDEO_ROOMS:{idFromName:()=>"one",get:()=>({fetch:forward})}} as Env;
    const request=(headers:Record<string,string>,method="POST",body=JSON.stringify({action:"signal",roomId:id}))=>new Request(`https://video.test/videoConsultation`,{method,headers:{"Content-Type":"application/json",...headers},...(method==="GET"?{}:{body})});
    expect((await handleVideoRequest(request({Origin:"https://attacker.test"}),configured)).status).toBe(403);
    expect((await handleVideoRequest(request({},"GET"),configured)).status).toBe(405);
    expect((await handleVideoRequest(request({},"POST",'x'.repeat(100001)),configured)).status).toBe(413);expect(forward).not.toHaveBeenCalled();
    const response=await handleVideoRequest(request({"X-Video-Owner":"forged","X-Video-Auth-Expiry":"9999999999999"}),configured);
    expect(await response.json()).not.toHaveProperty("x-video-owner");
    const denied=vi.fn(async()=>{throw Error("not authenticated");});
    expect((await handleVideoRequest(request({Authorization:"Bearer bad"}),configured,denied)).status).toBe(503);expect(forward).toHaveBeenCalledOnce();
  });
});

describe("actual workerd SQLite consultation coordinator",()=>{
  let mf:Miniflare,token:string,ownerLookups=0,turnCalls=0,keyRequests=0,denyTurn=false;
  const smsRequests:{path:string;body:any}[]=[];let smsUnknown=false;
  beforeAll(async()=>{
    token=await signed();
    const result=await build({absWorkingDir:process.cwd(),stdin:{resolveDir:process.cwd(),contents:`
      import worker,{VideoRooms} from './src/worker.ts';export default worker;
      export class InspectableRooms extends VideoRooms {
        constructor(ctx,env){
          const counts={get:0,put:0,listRows:0,delete:0,alarmRead:0,alarmWrite:0};
          const count=target=>new Proxy(target,{get(t,key){const value=t[key];if(typeof value!=='function')return value;return(...args)=>{
            if(key==='transaction')return value.call(t,tx=>args[0](count(tx)));
            if(key==='get')counts.get+=Array.isArray(args[0])?args[0].length:1;
            if(key==='put')counts.put+=typeof args[0]==='string'?1:Object.keys(args[0]).length;
            if(key==='delete')counts.delete+=Array.isArray(args[0])?args[0].length:1;
            if(key==='getAlarm')counts.alarmRead++;if(key==='setAlarm')counts.alarmWrite++;
            const result=value.apply(t,args);if(key==='list')return result.then(rows=>{counts.listRows+=rows.size;return rows;});return result;
          };}});
          super({storage:count(ctx.storage)},env);this.storage=ctx.storage;this.counts=counts;
        }
        async fetch(request){
          const path=new URL(request.url).pathname;
          if(path==='/metrics')return Response.json(this.counts);
          if(path==='/inspect')return Response.json(Object.fromEntries(await this.storage.list()));
          if(path==='/purge-test'){await this.storage.put('videoConsultations/expired',{state:'ended'});await this.storage.put('purge/1/expired','videoConsultations/expired');await this.alarm();return Response.json(Object.fromEntries(await this.storage.list()));}
          return super.fetch(request);
        }
      }`},bundle:true,write:false,format:"esm",platform:"neutral",conditions:["workerd","worker","browser"],external:["node:*","cloudflare:*"],logLevel:"silent"});
    mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:"ESModule",path:"worker.mjs",contents:result.outputFiles[0].text}],compatibilityDate:"2026-11-03",compatibilityFlags:["nodejs_compat"],bindings:env,
      durableObjects:{VIDEO_ROOMS:{className:"InspectableRooms",useSQLite:true}},
      outboundService:async request=>{
        const url=new URL(request.url);
        if(url.hostname==="www.googleapis.com"){keyRequests++;return Response.json(publicJwks,{headers:{"Cache-Control":"public, max-age=3600"}});}
        if(url.hostname==="identitytoolkit.googleapis.com"){ownerLookups++;return Response.json({users:[{localId:"viewer-1",validSince:"1"}]});}
        if(url.hostname==="rtc.live.cloudflare.com"){turnCalls++;return denyTurn?new Response("blocked",{status:503}):Response.json(relay,{status:201});}
        if(url.hostname==="api.textbee.dev"){
          const body=request.method==="POST"?await request.json():null;smsRequests.push({path:url.pathname,body});
          if(url.pathname.endsWith("/send-sms"))return smsUnknown?new Response("provider failure",{status:503}):Response.json({data:{success:true,smsBatchId:"fixture-batch"}});
          const device={_id:"664a9b8cd0e1f2a3b4c5d6e7",name:"Office SMS phone",enabled:true,lastHeartbeat:new Date().toISOString(),heartbeatIntervalMinutes:30,simInfo:{sims:[{subscriptionId:7,serviceState:"IN_SERVICE"}]}};
          return Response.json({data:url.pathname.endsWith("/devices")?[device]:device});
        }
        return new Response("No other network allowed",{status:500});
      }}));
    await mf.ready;
  },30_000);
  afterAll(async()=>{await mf?.dispose();});
  async function call(action:string,data:Record<string,unknown>={},owner=true){return mf.dispatchFetch("https://video.test/videoConsultation",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",...(owner?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({action,roomId:id,...data})});}
  async function stored(path="/inspect"){
    const namespace=await mf.getDurableObjectNamespace("VIDEO_ROOMS"),stub=namespace.get(namespace.idFromName("consultations-v1"));
    return (await stub.fetch(`https://private.test${path}`)).json() as Promise<Record<string,any>>;
  }
  it("creates a real durable room through the exported Worker, claims one guest and streams only role-bound signals",async()=>{
    const response=await call("create");expect(response.status,await response.clone().text()).toBe(200);
    const created=await response.json() as any;expect(created).toMatchObject({smsAvailable:false,rtc:{iceTransportPolicy:"all"}});
    expect(JSON.stringify(created)).not.toContain(env.CLOUDFLARE_TURN_API_TOKEN);expect(turnCalls).toBe(1);expect(keyRequests).toBe(1);
    const invite=new URLSearchParams(new URL(created.link).hash.slice(1)),guest={token:invite.get("token"),guestKey:"g".repeat(43)};
    const results=await Promise.all([call("join",guest,false),call("join",{...guest,guestKey:"h".repeat(43)},false)]);
    expect(results.map(value=>value.status).sort()).toEqual([200,409]);expect(turnCalls).toBe(2);
    const ownerStream=await call("watch"),guestStream=await call("watch",guest,false);
    expect(ownerStream.headers.get("access-control-allow-origin")).toBe(origin);expect(ownerStream.headers.get("content-type")).toBe("text/event-stream");
    const ownerReader=ownerStream.body!.getReader(),guestReader=guestStream.body!.getReader();
    const decode=async(reader:ReadableStreamDefaultReader<Uint8Array>)=>new TextDecoder().decode((await reader.read()).value);
    expect(await decode(ownerReader)).toContain('"state":"joined"');expect(await decode(guestReader)).toContain('"state":"joined"');
    expect((await call("watch")).status).toBe(409);
    expect((await call("signal",{description:{type:"offer",sdp:"v=0\r\n"}})).status).toBe(200);
    expect(await decode(guestReader)).toContain('"offer"');expect(await decode(ownerReader)).not.toContain('"offer"');
    const before=turnCalls;expect((await call("join",{...guest,token:"z".repeat(43)},false)).status).toBe(403);expect(turnCalls).toBe(before);
    expect((await call("end",guest,false)).status).toBe(200);
    expect(await decode(ownerReader)).toContain('"state":"ended"');expect(await decode(guestReader)).toContain('"state":"ended"');
    expect((await ownerReader.read()).done).toBe(true);expect((await guestReader.read()).done).toBe(true);
    const docs=await stored();expect(docs[`videoConsultations/${id}`]).toMatchObject({state:"ended",viewerCandidates:[],guestCandidates:[]});expect(docs[`videoConsultations/${id}`].offer).toBeUndefined();
    expect(Object.keys(docs).every(key=>key.startsWith("videoConsultation")||key.startsWith("purge/"))).toBe(true);
    expect((await call("sms",{phone:"01012345678",token:guest.token})).status).toBe(412);
  },20_000);
  it("rolls back a failed real relay request and lets the same action retry without an orphan or paid fallback",async()=>{
    const other="123e4567-e89b-42d3-a456-426614174001";denyTurn=true;
    expect((await call("create",{roomId:other})).status).toBe(503);expect((await stored())[`videoConsultations/${other}`]).toBeUndefined();
    denyTurn=false;const restored=await call("create",{roomId:other});expect(restored.status,await restored.clone().text()).toBe(200);expect((await call("end",{roomId:other})).status).toBe(200);
    const docs=await stored("/purge-test");expect(docs["videoConsultations/expired"]).toBeUndefined();expect(docs["purge/1/expired"]).toBeUndefined();expect(docs[`videoConsultations/${id}`]).toBeDefined();
    expect(ownerLookups).toBeGreaterThan(0);expect(keyRequests).toBe(1);
  },20_000);
  it("measures a complete32ICE-per-role consultation without Firestore, polling or extra relay generation",async()=>{
    const roomId="123e4567-e89b-42d3-a456-426614174002",start={ownerLookups,turnCalls},initial=await stored("/metrics");
    let calls=0;const request=(action:string,data:Record<string,unknown>={},owner=true)=>{calls++;return call(action,{roomId,...data},owner);};
    const created=await (await request("create")).json() as any;
    const query=new URLSearchParams(new URL(created.link).hash.slice(1)),guest={token:query.get("token"),guestKey:"g".repeat(43)};
    expect((await request("join",guest,false)).status).toBe(200);
    const streams=[await request("watch"),await request("watch",guest,false)];
    const readers=streams.map(response=>response.body!.getReader());
    const drain=readers.map(async reader=>{while(!(await reader.read()).done){}});
    for(const owner of [true,false]){
      expect((await request("signal",{...(!owner?guest:{}),description:{type:owner?"offer":"answer",sdp:"v=0"}},owner)).status).toBe(200);
      for(let i=0;i<32;i++)expect((await request("signal",{...(!owner?guest:{}),candidate:{candidate:`candidate:${i}`,sdpMid:"0",sdpMLineIndex:0}},owner)).status).toBe(200);
    }
    expect((await request("end",guest,false)).status).toBe(200);expect((await request("end")).status).toBe(200);await Promise.all(drain);
    expect({calls,ownerLookups:ownerLookups-start.ownerLookups,turnCalls:turnCalls-start.turnCalls}).toEqual({calls:72,ownerLookups:36,turnCalls:2});
    const end=await stored("/metrics");
    const delta=Object.fromEntries(Object.keys(end).map(key=>[key,end[key]-initial[key]]));
    expect(delta).toEqual({get:76,put:71,listRows:0,delete:0,alarmRead:1,alarmWrite:0});
  },20_000);
  it("connects actual Viewer and phone browsers through the Worker HTTP/SSE API and receives fresh video",async()=>{
    const {chromium}=require("../../../aether-link-app/node_modules/playwright"),endpoint=new URL("/videoConsultation",await mf.ready).href;
    const preflight=await fetch(endpoint,{method:"OPTIONS",headers:{Origin:"http://localhost","Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"authorization,content-type"}});
    expect(preflight.status,await preflight.text()).toBe(204);expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost");
    const client=await build({absWorkingDir:resolve("../../aether-link-app"),stdin:{resolveDir:resolve("../../aether-link-app"),loader:"tsx",contents:`
      import React from 'react';import{createRoot}from'react-dom/client';import{VideoConsultation}from'./src/components/VideoConsultation';
      window.tracks=[];const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{const stream=await media(c);window.tracks.push(...stream.getTracks());return stream;};
      const NativePeer=RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(config){window.receivedRtc=config;super({...config,iceServers:[]});}};
      window.mount=guest=>createRoot(document.getElementById('root')).render(<VideoConsultation guest={guest}/>);
    `},bundle:true,write:false,format:"iife",platform:"browser",define:{"import.meta.env":JSON.stringify({VITE_WONREMOTE_VIDEO_API_URL:endpoint}),"process.env.NODE_ENV":'"development"'},plugins:[{name:"fixture-owner-identity",setup(builder:any){builder.onResolve({filter:/firebaseServices$/},()=>({path:"identity",namespace:"fixture"}));builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`export const getWonRemoteFirebaseServices=()=>({auth:{currentUser:{getIdToken:async()=>window.fixtureToken}}});`,loader:"js"}));}}],logLevel:"silent"});
    const browser=await chromium.launch({headless:true,args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
    try{
      const open=async(guest?:Record<string,string|null>)=>{
        const page=await browser.newPage({viewport:guest?{width:390,height:844}:{width:1280,height:800}});page.setDefaultTimeout(10_000);
        // Only the local workerd test URL needs Chrome loopback permission.
        await page.context().grantPermissions(["local-network-access"]);
        page.on("pageerror",(error:Error)=>console.error("Browser fixture:",error.message));
        page.on("console",(message:any)=>{if(message.type()==="error")console.error("Browser request:",message.text());});
        await page.route("http://localhost/**",(route:any)=>route.fulfill({contentType:"text/html",body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>'}));
        await page.goto("http://localhost/video-support");await page.addStyleTag({content:readFileSync(resolve("../../aether-link-app/src/styles.css"),"utf8")});
        await page.evaluate((value:string)=>{(window as any).fixtureToken=value;},token);await page.addScriptTag({content:client.outputFiles[0].text});
        await page.evaluate((value:any)=>(window as any).mount(value),guest);return page;
      };
      const owner=await open();await owner.getByRole("button",{name:"영상상담 시작",exact:true}).click();
      const link=owner.getByRole("textbox",{name:"영상상담 초대 링크"});await link.waitFor().catch(async()=>{throw Error(`Invitation not shown: ${await owner.locator('body').innerText()}`);});
      const params=new URLSearchParams(new URL(await link.inputValue()).hash.slice(1)),guest=await open({roomId:params.get("room"),token:params.get("token")});
      expect(await guest.evaluate(()=>(window as any).tracks.length)).toBe(0);
      await guest.getByRole("button",{name:"카메라 허용하고 시작",exact:true}).click();
      await owner.waitForFunction(()=>{const v=document.querySelector('video')!;return v.readyState>=2&&v.videoWidth>0;});
      const picture=()=>owner.locator('video').evaluate((video:HTMLVideoElement)=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const context=canvas.getContext('2d')!;context.drawImage(video,0,0,64,36);
        return {colors:new Set(Array.from(context.getImageData(0,0,64,36).data)).size,frames:video.getVideoPlaybackQuality().totalVideoFrames,audio:(video.srcObject as MediaStream).getAudioTracks().length};
      });
      const first=await picture();expect(first.colors).toBeGreaterThan(20);expect(first.audio).toBe(0);
      await owner.waitForFunction((count:number)=>document.querySelector('video')!.getVideoPlaybackQuality().totalVideoFrames>count+2,first.frames);
      expect(await owner.evaluate(()=>(window as any).receivedRtc.iceServers[1].username)).toBe("temporary-user");
      expect(await owner.getByRole("button",{name:"마이크 켜기",exact:true}).count()).toBe(0);
      const folder=resolve("../../.codex-tmp/cloudflare-video");mkdirSync(folder,{recursive:true});await owner.screenshot({path:resolve(folder,"viewer.png")});await guest.screenshot({path:resolve(folder,"phone.png")});
      await guest.getByRole("button",{name:"상담 종료",exact:true}).click();await owner.getByRole("status").filter({hasText:"상담 종료"}).waitFor();
      for(const page of [owner,guest])expect(await page.evaluate(()=>(window as any).tracks.every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
    }finally{await browser.close();}
  },30_000);
  it("routes actual Worker SMS to only the selected phone/SIM and reserves one send across simultaneous clicks or uncertain failure",async()=>{
    const selection={smsMode:"pc",smsPcKey:"p".repeat(43)},key="testbee-private-key-fixture",deviceId="664a9b8cd0e1f2a3b4c5d6e7";
    expect((await call("sms-route",selection,false)).status).toBe(401);
    expect((await call("sms-save",{...selection,apiKey:key,deviceId,simId:7,number:"01012345678"})).status).toBe(200);
    const setting=await (await call("sms-route",selection)).json() as any;expect(setting.phone).toMatchObject({deviceId,simId:7,ready:true});
    expect(await (await call("sms-route",{...selection,smsPcKey:"q".repeat(43)})).json()).toEqual({phone:null});
    expect(JSON.stringify(await stored())).not.toContain(key);
    for(const uncertain of [false,true]){
      smsUnknown=uncertain;const roomId=uncertain?"123e4567-e89b-42d3-a456-426614174005":"123e4567-e89b-42d3-a456-426614174004";
      const created=await (await call("create",{roomId})).json() as any;
      expect(created.smsRoutingAvailable).toBe(true);const invite=new URLSearchParams(new URL(created.link).hash.slice(1));
      smsRequests.length=0;
      const data={...selection,roomId,token:invite.get("token"),phone:"01098765432"};
      const initial=await stored("/metrics");
      const results=await Promise.all([call("sms",data),call("sms",data)]);
      expect(results.map(r=>r.status).sort()).toEqual(uncertain?[409,502]:[200,409]);
      const end=await stored("/metrics");expect(end.put-initial.put).toBe(2);expect(end.get-initial.get).toBeGreaterThanOrEqual(4);expect(end.get-initial.get).toBeLessThanOrEqual(5);
      expect(smsRequests).toHaveLength(2);expect(smsRequests[1].body).toMatchObject({deviceId,simSubscriptionId:7,recipients:["+821098765432"]});
      expect((await call("sms",data)).status).toBe(409);expect(smsRequests).toHaveLength(2);
      expect((await stored())[`videoConsultations/${roomId}`].smsState).toBe(uncertain?"unknown":"accepted");
      await call("end",{roomId});
    }
    smsUnknown=false;
  },20_000);
});
