import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createSmsGateway, sealSmsKey, smsProfileKey } from "../src/sms";
import { handleVideoRequest, VideoRooms, type Env } from "../src/worker";
import { videoHash } from "../../../functions/src/videoConsultationCore";

const deviceId="664a9b8cd0e1f2a3b4c5d6e7",otherId="664a9b8cd0e1f2a3b4c5d6e8",apiKey="textbee-fixture-key-12345",secret="i".repeat(32);
const pcA={smsMode:"pc",smsPcKey:"a".repeat(43)},pcB={smsMode:"pc",smsPcKey:"b".repeat(43)},counselor={...pcA,smsMode:"counselor"};
function fixture(){
  const docs=new Map<string,any>(),counts={get:0,put:0,delete:0};
  const storage={get:async<T>(key:string)=>{counts.get++;return structuredClone(docs.get(key)) as T|undefined;},put:async(key:string,value:unknown)=>{counts.put++;docs.set(key,structuredClone(value));},delete:async(key:string)=>{counts.delete++;return docs.delete(key);}};
  let state="IN_SERVICE",heartbeat=Date.now(),enabled=true,fail=false,redirect=false;
  const device=(id=deviceId)=>({_id:id,name:id===deviceId?"Office phone":"Counselor phone",enabled,lastHeartbeat:new Date(heartbeat).toISOString(),heartbeatIntervalMinutes:30,networkInfo:{networkType:"wifi"},simInfo:{sims:[{subscriptionId:7,serviceState:state}]}});
  const send=vi.fn(async(url:string|URL|Request,options?:RequestInit)=>{
    if(fail)throw new Error('provider secret must not escape');
    if(redirect)return new Response(null,{status:302,headers:{Location:"https://attacker.test"}});
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/send-sms'))return Response.json({data:{success:true,smsBatchId:"accepted-batch"}});
    if(path.endsWith('/devices'))return Response.json({data:[device(),device(otherId)]});
    return Response.json({data:device(path.split('/').at(-1))});
  });
  const service=createSmsGateway(storage,secret,send as typeof fetch);
  const save=(owner="viewer-1",context=pcA,id=deviceId)=>service.execute(owner,{...context,action:"sms-save",apiKey,deviceId:id,simId:7,number:"01012345678"});
  return {docs,counts,storage,send,service,save,device,setOffline:()=>{heartbeat=Date.now()-3_600_001;},setDisabled:()=>{enabled=false;},setBadSim:()=>{state="OUT_OF_SERVICE";},setFailure:()=>{fail=true;},setRedirect:()=>{redirect=true;}};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("designated SMS phone routing",()=>{
  it("separates PC capabilities from counselor UIDs and never returns or stores a plaintext provider key",async()=>{
    const f=fixture();await f.save();
    expect(JSON.stringify([...f.docs])).not.toContain(apiKey);
    expect(await f.service.execute("viewer-2",{...pcA,action:"sms-route"})).toMatchObject({phone:{deviceId,ready:true}});
    expect(await f.service.execute("viewer-1",{...pcB,action:"sms-route"})).toEqual({phone:null});
    await f.save("viewer-1",counselor,otherId);
    expect(await f.service.execute("viewer-1",{...counselor,smsPcKey:pcB.smsPcKey,action:"sms-route"})).toMatchObject({phone:{deviceId:otherId}});
    expect(await f.service.execute("viewer-2",{...counselor,action:"sms-route"})).toEqual({phone:null});
    const response=await f.service.execute("viewer-1",{...pcA,action:"sms-route"});expect(JSON.stringify(response)).not.toContain(apiKey);expect(response).not.toHaveProperty('sealed');
    const original=f.docs.get(smsProfileKey("viewer-1",pcA));f.docs.set(smsProfileKey("viewer-1",pcB),original);
    await expect(f.service.execute("viewer-1",{...pcB,action:"sms-route"})).rejects.toMatchObject({status:412});
    expect(sealSmsKey(apiKey,secret,"scope")).not.toEqual(sealSmsKey(apiKey,secret,"scope"));
  });
  it("uses explicit registered device and SIM, Korean E.164, and only acknowledges provider queue acceptance",async()=>{
    const f=fixture();await f.save();f.send.mockClear();
    const send=await f.service.prepare("viewer-1",pcA);await send("01098765432","https://wonremote-a7fd3.web.app/video-support#private");
    expect(f.send).toHaveBeenCalledTimes(2);
    const [url,options]=f.send.mock.calls[1];expect(String(url)).toBe("https://api.textbee.dev/api/v1/gateway/send-sms");
    expect(JSON.parse(options!.body as string)).toMatchObject({deviceId,simSubscriptionId:7,recipients:["+821098765432"]});
    expect(options?.redirect).toBe("manual");
  });
  it("fails closed for missing/stale/disabled/SIM mismatch and does not contact a default phone",async()=>{
    const f=fixture();await expect(f.service.prepare("viewer-1",pcA)).rejects.toMatchObject({status:412});expect(f.send).not.toHaveBeenCalled();
    for(const fail of ["setOffline","setDisabled","setBadSim"] as const){const g=fixture();await g.save();g[fail]();g.send.mockClear();await expect(g.service.prepare("viewer-1",pcA)).rejects.toMatchObject({status:412});expect(g.send).toHaveBeenCalledOnce();expect(String(g.send.mock.calls[0][0])).toContain(`/devices/${deviceId}`);}
    await expect(f.service.execute("viewer-1",{...pcA,action:"sms-save",apiKey,deviceId,simId:99,number:"01012345678"})).rejects.toMatchObject({status:400});expect(f.docs.size).toBe(0);
    for(const fail of ["setFailure","setRedirect"] as const){const g=fixture();await g.save();g[fail]();await expect(g.service.prepare("viewer-1",pcA)).rejects.toBeInstanceOf(Error);expect(g.send.mock.calls.filter(x=>String(x[0]).endsWith('/send-sms'))).toHaveLength(0);}
  });
  it("keeps24h idle traffic at zero and deletes only the chosen assignment",async()=>{
    vi.useFakeTimers();const f=fixture();await f.save();await f.save("viewer-1",counselor,otherId);
    const before={...f.counts},requests=f.send.mock.calls.length;await vi.advanceTimersByTimeAsync(86_400_000);
    expect(f.counts).toEqual(before);expect(f.send).toHaveBeenCalledTimes(requests);expect(vi.getTimerCount()).toBe(0);
    await f.service.execute("viewer-1",{...pcA,action:"sms-remove"});expect(f.docs.has(smsProfileKey("viewer-1",pcA))).toBe(false);expect(f.docs.has(smsProfileKey("viewer-1",counselor))).toBe(true);
  });
  it("requires verified Viewer identity for settings and strips spoofed identity headers",async()=>{
    const forward=vi.fn(async(request:Request)=>Response.json(Object.fromEntries(request.headers)));
    const env={PUBLIC_ORIGIN:"https://viewer.test",VIDEO_ROOMS:{idFromName:()=>"one",get:()=>({fetch:forward})}} as unknown as Env;
    const request=(auth=false)=>new Request("https://video.test/videoConsultation",{method:"POST",headers:{"Content-Type":"application/json","X-Video-Owner":"forged",...(auth?{Authorization:"Bearer fixture"}:{})},body:JSON.stringify({action:"sms-route",...pcA})});
    expect((await handleVideoRequest(request(),env)).status).toBe(401);expect(forward).not.toHaveBeenCalled();
    const result=await handleVideoRequest(request(true),env,async()=>({uid:"verified",expiresAt:Date.now()+60_000}));expect(await result.json()).toMatchObject({"x-video-owner":"verified"});
  });
  it("does not block video signaling behind a slow phone provider and rejects overlapping SMS immediately",async()=>{
    const f=fixture();await f.save();const roomId="123e4567-e89b-42d3-a456-426614174000",token=createHmac("sha256",secret).update(roomId).digest("base64url");
    f.docs.set(`videoConsultations/${roomId}`,{id:roomId,ownerUid:"viewer-1",inviteHash:videoHash(token),smsState:"none",state:"waiting",expiresAt:Date.now()+60_000,inviteExpiresAt:Date.now()+60_000,viewerCandidates:[],guestCandidates:[]});
    const storage={...f.storage,transaction:async(action:any)=>action(f.storage)};
    const rooms=new VideoRooms({storage} as any,{VIDEO_INVITE_SECRET:secret,PUBLIC_ORIGIN:"https://video.test"} as Env);
    let release!:()=>void,start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    vi.stubGlobal("fetch",async(url:any,options:any)=>{if(String(url).includes('/devices/')){start();await gate;}return f.send(url,options);});
    const request=(action:string,data:Record<string,unknown>={})=>new Request('https://private.test/videoConsultation',{method:'POST',headers:{'Content-Type':'application/json','X-Video-Owner':'viewer-1','X-Video-Auth-Expiry':String(Date.now()+60_000)},body:JSON.stringify({roomId,action,...data})});
    const sending=rooms.fetch(request('sms',{...pcA,token,phone:'01098765432'}));await started;
    try{
      expect((await rooms.fetch(request('sms',{...pcA,token,phone:'01098765432'}))).status).toBe(409);
      let response:Response|undefined;const signaling=rooms.fetch(request('signal',{description:{type:'offer',sdp:'v=0'}})).then(value=>{response=value;});
      await vi.waitFor(()=>expect(response?.status).toBe(200),{timeout:1000});await signaling;
    }finally{release();expect((await sending).status).toBe(200);}
    expect(f.send.mock.calls.filter(x=>String(x[0]).endsWith('/send-sms'))).toHaveLength(1);
  });
});
