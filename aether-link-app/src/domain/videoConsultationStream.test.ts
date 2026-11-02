import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireVideoViewer, streamVideoRoom } from "../../../functions/src/videoConsultation";
import { BOOTSTRAP_VIEWER_UID } from "../../../functions/src/viewerAccounts";
import type { VideoRoom, VideoStore } from "../../../functions/src/videoConsultationCore";

function fixture(immediate=false){
  const end=vi.fn(),write=vi.fn((_value:string)=>true),unsubscribe=vi.fn();
  const res=Object.assign(new EventEmitter(),{destroyed:false,set:vi.fn(),flushHeaders:vi.fn(),end,write});
  const room={id:"room",ownerUid:"owner",state:"waiting",expiresAt:Date.now()+60_000,smsState:"none",viewerCandidates:[],guestCandidates:[]} as unknown as VideoRoom;
  let next:(room:VideoRoom|undefined)=>void=()=>{};
  const store={watch:vi.fn((_id,callback)=>{next=callback;if(immediate)callback({...room,state:"ended"});return unsubscribe;})} as unknown as VideoStore;
  streamVideoRoom(store,res as never,"room","owner",{},Date.now()+60_000);
  return {res,write,end,unsubscribe,room,store,next:(value:VideoRoom)=>next(value)};
}
afterEach(()=>{vi.useRealTimers();});
describe("video consultation HTTP boundary",()=>{
  it("denies normal Agent and unrelated admin claims; accepts only Viewer role or bootstrap",()=>{
    expect(()=>requireVideoViewer({uid:"agent",wonremoteAdmin:true})).toThrow();
    expect(()=>requireVideoViewer({uid:"agent",wonremoteViewer:"true"})).toThrow();
    expect(requireVideoViewer({uid:"viewer",wonremoteViewer:true})).toBe("viewer");
    expect(requireVideoViewer({uid:BOOTSTRAP_VIEWER_UID})).toBe(BOOTSTRAP_VIEWER_UID);
  });
  it("sends idle comments without database rereads and stops all work on disconnect",()=>{
    vi.useFakeTimers();const f=fixture();f.next(f.room);
    vi.advanceTimersByTime(50_000);expect(f.write.mock.calls.filter(([value])=>value===": keepalive\n\n")).toHaveLength(2);
    expect(f.store.watch).toHaveBeenCalledTimes(1);
    f.res.emit("close");expect(f.unsubscribe).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it("closes on deadline, ended room, invalid owner, synchronous callback, and backpressure",()=>{
    vi.useFakeTimers();const a=fixture();vi.advanceTimersByTime(60_000);expect(a.end).toHaveBeenCalledTimes(1);expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    const b=fixture(true);expect(b.unsubscribe).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
    const c=fixture();c.next({...c.room,ownerUid:"other"});expect(c.end).toHaveBeenCalled();
    const d=fixture();d.write.mockReturnValue(false);d.next(d.room);expect(d.unsubscribe).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it("streams descriptions and candidates only once per observer",()=>{
    vi.useFakeTimers();const f=fixture();const room={...f.room,offer:{type:"offer" as const,sdp:"v=0"},answer:{type:"answer" as const,sdp:"v=0"},guestCandidates:[{candidate:"candidate:test",sdpMid:"0",sdpMLineIndex:0}]};
    f.next(room);f.next(room);
    const messages=f.write.mock.calls.map(([value])=>JSON.parse(String(value).slice(6)));
    expect(messages[0].offer).toBeUndefined();expect(messages[0].answer).toBeTruthy();expect(messages[1].answer).toBeUndefined();expect(messages[1].guestCandidates).toEqual([]);
    f.res.emit("close");
  });
});
