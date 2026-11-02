import { afterEach, describe, expect, it, vi } from "vitest";
const user=vi.hoisted(()=>({getIdToken:vi.fn(async()=>"viewer-id-token")}));
const services=vi.hoisted(()=>vi.fn(()=>({auth:{currentUser:user}})));
vi.mock("../firebase/firebaseServices",()=>({getWonRemoteFirebaseServices:services}));
import { createVideoApi, readVideoInvite } from "./videoConsultationApi";
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks();});
describe("video HTTP client",()=>{
  it("keeps guest capability out of URLs, referrers and Firebase auth, while owner sends only its ID token",async()=>{
    const fetcher=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal("fetch",fetcher);
    const api=createVideoApi({token:"t".repeat(43),guestKey:"g".repeat(43)});
    await api.call("join","room",{});expect(services).not.toHaveBeenCalled();
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toMatch(/^https:\/\/us-central1-wonremote-a7fd3\.cloudfunctions\.net\/videoConsultation$/);
    expect(init).toMatchObject({credentials:"omit",referrerPolicy:"no-referrer",cache:"no-store"});
    expect((init.headers as Record<string,string>).Authorization).toBeUndefined();expect(JSON.parse(String(init.body))).toMatchObject({token:"t".repeat(43),guestKey:"g".repeat(43)});
    await createVideoApi().call("create","room",{});
    expect((fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].headers).toMatchObject({Authorization:"Bearer viewer-id-token"});
    fetcher.mockImplementation(async()=>new Response('data: {"state":"ended"}\n\n',{headers:{"content-type":"text/event-stream"}}));
    await createVideoApi().watch("room",()=>{},new AbortController().signal);expect(user.getIdToken).toHaveBeenLastCalledWith(true);
    expect(readVideoInvite("#room=bad&token=bad")).toBeNull();
  });
  it("decodes split event frames, ignores heartbeats, and cancels the reader at end",async()=>{
    const cancel=vi.fn();let source:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(c){source=c;},cancel});
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body,{headers:{"content-type":"text/event-stream"}})));
    const updates:unknown[]=[];
    const watch=createVideoApi({token:"t",guestKey:"g"}).watch("room",v=>updates.push(v),new AbortController().signal);
    const bytes=new TextEncoder().encode(': keepalive\n\ndata: {"state":"joined","message":"상담 중"}\n\ndata: {"state":"ended"}\n\n');
    for(let i=0;i<bytes.length;i+=7)source!.enqueue(bytes.slice(i,i+7));
    await watch;expect(updates).toEqual([{state:"joined",message:"상담 중"},{state:"ended"}]);expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects malformed streams and server errors; bounds commands and cancels on parent abort",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('data: {"state":"wrong"}\n\n',{headers:{"content-type":"text/event-stream"}})));
    const api=createVideoApi({token:"t",guestKey:"g"});await expect(api.watch("room",()=>{},new AbortController().signal)).rejects.toThrow("올바르지");
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({error:"업체 미설정"},{status:412})));await expect(api.call("sms","room",{})).rejects.toThrow("업체 미설정");
    vi.useFakeTimers();vi.stubGlobal("fetch",vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new DOMException("abort","AbortError"))))));
    const timed=expect(api.call("join","room",{})).rejects.toMatchObject({name:"AbortError"});await vi.advanceTimersByTimeAsync(20_000);await timed;
    const parent=new AbortController(),aborted=expect(api.call("join","room",{},parent.signal)).rejects.toMatchObject({name:"AbortError"});parent.abort();await aborted;expect(vi.getTimerCount()).toBe(0);
  });
});
