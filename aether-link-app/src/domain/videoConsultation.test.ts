import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVideoService, VIDEO_INVITE_MS, VIDEO_ROOM_MS, type VideoStore, type VideoTransaction } from "../../../functions/src/videoConsultationCore";
import { solapiVideoSms } from "../../../functions/src/videoConsultationSms";
import { readVideoInvite } from "../api/videoConsultationApi";

const id="123e4567-e89b-42d3-a456-426614174000",nextId="123e4567-e89b-42d3-a456-426614174001";
function fixture(sms?: (phone:string,link:string)=>Promise<void>){
  const documents=new Map<string,Record<string,unknown>>();let reads=0,writes=0,time=1_800_000_000_000,tail=Promise.resolve();
  const store:VideoStore={watch:()=>()=>{},transact:action=>{
    const result=tail.then(async()=>{
      const staged=new Map<string,Record<string,unknown>>();
      const tx:VideoTransaction={get:async path=>{reads++;return structuredClone(documents.get(path));},put:(path,value)=>{staged.set(path,structuredClone(value));}};
      const value=await action(tx);for(const [path,doc] of staged){writes++;documents.set(path,doc);}return value;
    });tail=result.then(()=>undefined,()=>undefined);return result;
  }};
  const service=createVideoService(store,{origin:"https://example.test",inviteSecret:"a".repeat(32),now:()=>time,rtc:()=>({iceServers:[]}),sms});
  const call=(owner:string|null,action:string,extra:Record<string,unknown>={})=>service.execute(owner,{roomId:id,action,...extra});
  return {call,documents,store,service,counts:()=>({reads,writes}),advance:(ms:number)=>{time+=ms;}};
}
async function invite(f:ReturnType<typeof fixture>){
  const result=await f.call("viewer-1","create");
  const token=new URL(String(result.link)).hash.match(/token=([^&]+)/)![1];
  return {token,guestKey:"b".repeat(43)};
}
describe("isolated video consultation service",()=>{
  it("awaits asynchronous relay configuration and does not commit a room or guest claim on relay failure",async()=>{
    const f=fixture(),rtc=vi.fn(async()=>({iceServers:[{urls:["turn:turn.cloudflare.com:3478"]}]}));
    const service=createVideoService(f.store,{origin:"https://example.test",inviteSecret:"a".repeat(32),rtc});
    const created=await service.execute("viewer-1",{roomId:id,action:"create"});
    expect(created.rtc).toEqual({iceServers:[{urls:["turn:turn.cloudflare.com:3478"]}]});expect(rtc).toHaveBeenCalledOnce();
    rtc.mockRejectedValueOnce(new Error("relay unavailable"));
    const token=new URL(String(created.link)).hash.match(/token=([^&]+)/)![1],before=f.counts().writes;
    await expect(service.execute(null,{roomId:id,action:"join",token,guestKey:"b".repeat(43)})).rejects.toThrow("relay unavailable");
    expect(f.counts().writes).toBe(before);expect(f.documents.get(`videoConsultations/${id}`)?.guestHash).toBeUndefined();
    const empty=fixture(),failed=createVideoService(empty.store,{origin:"https://example.test",inviteSecret:"a".repeat(32),rtc:async()=>{throw Error("unavailable");}});
    await expect(failed.execute("viewer-1",{roomId:id,action:"create"})).rejects.toThrow("unavailable");expect(empty.documents.size).toBe(0);
  });
  it("mints one relay credential across a retried transaction and rejects guests before minting",async()=>{
    const f=fixture(),rtc=vi.fn(async()=>({iceServers:[]}));
    let first=true;
    const retry:VideoStore={watch:()=>()=>{},transact:async action=>{
      if(first){first=false;const staged=new Map<string,Record<string,unknown>>();await action({get:async()=>undefined,put:(path,value)=>{staged.set(path,value);}});}
      return f.store.transact(action);
    }};
    const service=createVideoService(retry,{origin:"https://example.test",inviteSecret:"a".repeat(32),rtc});
    await service.execute("viewer-1",{roomId:id,action:"create"});expect(rtc).toHaveBeenCalledOnce();
    await expect(service.execute(null,{roomId:id,action:"join",token:"z".repeat(43),guestKey:"b".repeat(43)})).rejects.toThrow("초대");expect(rtc).toHaveBeenCalledOnce();
  });
  it("creates an expiring fragment link, keeps no plain invitation or phone, and deduplicates create",async()=>{
    const f=fixture(),guest=await invite(f),before=f.counts();
    const again=await f.call("viewer-1","create");expect(new URL(String(again.link)).search).toBe("");
    expect(readVideoInvite(new URL(String(again.link)).hash)?.token).toBe(guest.token);
    expect(f.counts().writes).toBe(before.writes);
    expect(JSON.stringify([...f.documents.values()])).not.toContain(guest.token);
    expect(Number(again.expiresAt)-Number(again.inviteExpiresAt)).toBe(VIDEO_ROOM_MS-VIDEO_INVITE_MS);
    await expect(f.service.execute("viewer-1",{action:"create",roomId:nextId})).rejects.toThrow("열린 영상상담");
    await expect(f.call("other-viewer","create")).rejects.toThrow("다른 상담원");
  });
  it("rejects guessed capabilities before database access and cannot grant device credentials",async()=>{
    const f=fixture(),before=f.counts();
    await expect(f.call(null,"join",{token:"c".repeat(43),guestKey:"b".repeat(43)})).rejects.toThrow("초대 정보");
    expect(f.counts()).toEqual(before);
    const guest=await invite(f);
    const joined=await f.call(null,"join",guest);expect(joined).not.toHaveProperty("customToken");
    expect([...f.documents.keys()].every(path=>path.startsWith("videoConsultation"))).toBe(true);
    await expect(f.call(null,"sms",{...guest,phone:"01012345678"})).rejects.toThrow("Viewer 로그인");
  });
  it("claims a link once transactionally but supports a retry from the same guest key",async()=>{
    const f=fixture(),guest=await invite(f);
    const values=await Promise.allSettled([f.call(null,"join",guest),f.call(null,"join",{...guest,guestKey:"d".repeat(43)})]);
    expect(values.filter(v=>v.status==="fulfilled")).toHaveLength(1);
    const before=f.counts();await f.call(null,"join",guest);expect(f.counts().writes).toBe(before.writes);
    await expect(f.call(null,"watch",{...guest,guestKey:"d".repeat(43)})).rejects.toThrow("다른 기기");
    await expect(f.call("viewer-2","watch")).rejects.toThrow("다른 상담원");
  });
  it("expires unused invitations and joined calls, and ending is idempotent",async()=>{
    const f=fixture(),guest=await invite(f);f.advance(VIDEO_INVITE_MS);
    await expect(f.call(null,"join",guest)).rejects.toThrow("만료");
    await f.call("viewer-1","end");const writes=f.counts().writes;await f.call("viewer-1","end");expect(f.counts().writes).toBe(writes);
    await expect(f.call(null,"watch",guest)).rejects.toThrow("종료");
    await f.service.execute("viewer-1",{action:"create",roomId:nextId});f.advance(VIDEO_ROOM_MS);
    await expect(f.service.execute("viewer-1",{action:"watch",roomId:nextId})).rejects.toThrow("만료");
  });
  it("does not send without provider configuration and reserves exactly one SMS under concurrency",async()=>{
    const disabled=fixture(),g=await invite(disabled);
    await expect(disabled.call("viewer-1","sms",{token:g.token,phone:"01012345678"})).rejects.toThrow("설정되지");
    const send=vi.fn(async()=>{}),f=fixture(send),guest=await invite(f);
    const results=await Promise.allSettled([f.call("viewer-1","sms",{token:guest.token,phone:"010-1234-5678"}),f.call("viewer-1","sms",{token:guest.token,phone:"01012345678"})]);
    expect(send).toHaveBeenCalledOnce();expect(results.filter(v=>v.status==="fulfilled")).toHaveLength(1);
    expect(JSON.stringify([...f.documents.values()])).not.toContain("01012345678");
  });
  it("keeps an uncertain SMS result nonretryable instead of falsely reporting delivery",async()=>{
    const send=vi.fn(async()=>{throw Error("timeout");}),f=fixture(send),guest=await invite(f);
    await expect(f.call("viewer-1","sms",{token:guest.token,phone:"01012345678"})).rejects.toThrow("자동 재전송하지");
    await expect(f.call("viewer-1","sms",{token:guest.token,phone:"01012345678"})).rejects.toThrow("중복 발송");
    expect(send).toHaveBeenCalledOnce();expect(f.documents.get(`videoConsultations/${id}`)?.smsState).toBe("unknown");
  });
  it("validates role-bound SDP/candidates, deduplicates repeats and caps signals",async()=>{
    const f=fixture(),guest=await invite(f);await f.call(null,"join",guest);
    await expect(f.call(null,"signal",{...guest,description:{type:"offer",sdp:"v=0"}})).rejects.toThrow("잘못된 영상");
    await f.call("viewer-1","signal",{description:{type:"offer",sdp:"v=0\r\n"}});
    const before=f.counts().writes;await f.call("viewer-1","signal",{description:{type:"offer",sdp:"v=0\r\n"}});expect(f.counts().writes).toBe(before);
    await f.call(null,"signal",{...guest,description:{type:"answer",sdp:"v=0"}});
    for(let i=0;i<32;i++)await f.call("viewer-1","signal",{candidate:{candidate:`candidate:${i}`,sdpMid:"0",sdpMLineIndex:0}});
    await expect(f.call("viewer-1","signal",{candidate:{candidate:"candidate:overflow",sdpMid:null,sdpMLineIndex:null}})).rejects.toThrow("한도");
    await expect(f.call(null,"signal",{...guest,candidate:{candidate:"x",sdpMid:null,sdpMLineIndex:null}})).rejects.toThrow("잘못된 네트워크");
    await f.call("viewer-1","end");await expect(f.call(null,"signal",{...guest,description:{type:"answer",sdp:"v=0"}})).rejects.toThrow("종료");
    const ended=f.documents.get(`videoConsultations/${id}`)!;expect(ended.offer).toBeUndefined();expect(ended.answer).toBeUndefined();expect(ended.viewerCandidates).toEqual([]);expect(ended.purgeAt).toBeInstanceOf(Date);
  });
  it("measures bounded core operations and stays idle without timers or database activity",async()=>{
    vi.useFakeTimers();try{
      const f=fixture(),guest=await invite(f);await f.call(null,"join",guest);
      for(const owner of ["viewer-1",null]){
        await f.call(owner,"signal",{...guest,description:{type:owner?"offer":"answer",sdp:"v=0"}});
        for(let i=0;i<32;i++)await f.call(owner,"signal",{...guest,candidate:{candidate:`candidate:${i}`,sdpMid:"0",sdpMLineIndex:0}});
      }
      await f.call("viewer-1","watch");await f.call(null,"watch",guest);await f.call("viewer-1","end");
      expect(f.counts()).toEqual({reads:72,writes:70});
      const before=f.counts();await vi.advanceTimersByTimeAsync(86_400_000);expect(f.counts()).toEqual(before);expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();}
  });
  it("caps new rooms per Viewer per hour without blocking a later window",async()=>{
    const f=fixture();
    for(let i=0;i<10;i++){
      const roomId=`123e4567-e89b-42d3-a456-${String(i).padStart(12,"0")}`;
      await f.service.execute("viewer-1",{action:"create",roomId});await f.service.execute("viewer-1",{action:"end",roomId});
    }
    await expect(f.call("viewer-1","create")).rejects.toThrow("생성 한도");
    f.advance(VIDEO_ROOM_MS);await expect(f.call("viewer-1","create")).resolves.toHaveProperty("link");
  });
});
it("uses the documented SOLAPI HMAC and sends one LMS without accepting uncertain responses",async()=>{
  const send=vi.fn(async()=>new Response(JSON.stringify({groupInfo:{count:{registeredSuccess:1}},failedMessageList:[]}),{status:200}));
  const adapter=solapiVideoSms({apiKey:"test-key",apiSecret:"test-secret",from:"0212345678"},send as typeof fetch);
  await adapter("01012345678","https://example.test/video-support#room=test");
  const [url,request]=send.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe("https://api.solapi.com/messages/v4/send-many/detail");
  const header=(request.headers as Record<string,string>).Authorization;
  const date=/date=([^,]+)/.exec(header)![1],salt=/salt=([^,]+)/.exec(header)![1];
  expect(header).toContain(createHmac("sha256","test-secret").update(date+salt).digest("hex"));
  expect(JSON.parse(String(request.body))).toMatchObject({messages:[{type:"LMS",to:"01012345678",from:"0212345678"}],allowDuplicates:false});
  expect(String(request.body)).not.toContain("test-secret");
  const failed=solapiVideoSms({apiKey:"a",apiSecret:"b",from:"0212345678"},async()=>new Response("{}"));
  await expect(failed("01012345678","https://example.test")).rejects.toThrow("not confirmed");
});
