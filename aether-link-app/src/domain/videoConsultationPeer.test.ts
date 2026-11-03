import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoPeer } from "./videoConsultationPeer";

afterEach(()=>vi.unstubAllGlobals());
describe("consultation signaling queues",()=>{
  it("applies the answer while a candidate upload is stalled, keeps candidate sends serial and cancels queued sends",async()=>{
    vi.stubGlobal("MediaStream",class { getTracks(){return [];} });
    let release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const call=vi.fn(async(_action:string,_id:string,data:Record<string,unknown>)=>{if(data.candidate)await blocked;return {};});
    const rtc={addTransceiver:vi.fn(),createOffer:async()=>({type:"offer",sdp:"v=0"}),setLocalDescription:vi.fn(async()=>{}),setRemoteDescription:vi.fn(async()=>{}),addIceCandidate:vi.fn(async()=>{}),close:vi.fn(),onicecandidate:null} as unknown as RTCPeerConnection;
    const onError=vi.fn();
    const peer=createVideoPeer({guest:false,roomId:"fixture",api:{call,watch:async()=>{}},configuration:{iceServers:[]},onStream:()=>{},onState:()=>{},onError,createPeer:()=>rtc});
    await peer.start();
    for(let i=0;i<40;i++)rtc.onicecandidate!({candidate:{candidate:`candidate:${i}`,sdpMid:"0",sdpMLineIndex:0}} as RTCPeerConnectionIceEvent);
    await vi.waitFor(()=>expect(call.mock.calls.filter(([, , data])=>data.candidate)).toHaveLength(1));
    const update=peer.update({state:"joined",answer:{type:"answer",sdp:"v=0 answer"},guestCandidates:[{candidate:"candidate:remote",sdpMid:"0",sdpMLineIndex:0}]});
    try {
      await vi.waitFor(()=>expect(rtc.setRemoteDescription).toHaveBeenCalledOnce(),{timeout:300});
      await update;expect(rtc.addIceCandidate).toHaveBeenCalledOnce();
    } finally { peer.close();release();await update; }
    await Promise.resolve();expect(call.mock.calls.filter(([, , data])=>data.candidate)).toHaveLength(1);expect(onError).not.toHaveBeenCalled();
  });
});
