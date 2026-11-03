import type { VideoApi, VideoSignal } from "../api/videoConsultationApi";

export function createVideoPeer(input:{
  guest:boolean;roomId:string;api:VideoApi;configuration:RTCConfiguration;stream?:MediaStream;
  onStream:(stream:MediaStream)=>void;onState:(state:RTCPeerConnectionState)=>void;onError:(error:Error)=>void;
  createPeer?:(configuration:RTCConfiguration)=>RTCPeerConnection;
}){
  const peer=(input.createPeer??(config=>new RTCPeerConnection(config)))(input.configuration);
  const incoming=new MediaStream();
  const controller=new AbortController();let closed=false,localCandidates=0,remoteDescription="",received:RTCIceCandidateInit[]=[];
  let tasks=Promise.resolve(),candidates=Promise.resolve();const seen=new Set<string>();
  const fail=(error:unknown)=>{if(!closed)input.onError(error instanceof Error?error:new Error("영상 연결에 실패했습니다."));};
  const publish=(data:Record<string,unknown>)=>input.api.call("signal",input.roomId,data,controller.signal);
  const enqueue=(action:()=>Promise<void>)=>{tasks=tasks.then(async()=>{if(!closed)await action();}).catch(fail);return tasks;};
  peer.ontrack=event=>{if(!closed&&event.track.kind==="video"){if(!incoming.getTracks().some(track=>track.id===event.track.id))incoming.addTrack(event.track);input.onStream(incoming);}else if(event.track.kind==="audio")event.track.stop();};
  peer.onconnectionstatechange=()=>{if(!closed)input.onState(peer.connectionState);};
  peer.onicecandidate=event=>{
    if(closed||!event.candidate||localCandidates>=32)return;
    localCandidates++;
    const c=event.candidate;
    // Slow candidate uploads must not hold incoming SDP behind an HTTP backlog.
    candidates=candidates.then(async()=>{if(!closed)await publish({candidate:{candidate:c.candidate,sdpMid:c.sdpMid,sdpMLineIndex:c.sdpMLineIndex}});}).catch(fail);
  };
  if(input.guest){for(const track of input.stream?.getVideoTracks()??[])peer.addTrack(track,input.stream!);}
  else peer.addTransceiver("video",{direction:"recvonly"});
  return {
    async start(){
      if(input.guest)return;
      return enqueue(async()=>{
        const offer=await peer.createOffer();if(closed)return;
        await peer.setLocalDescription(offer);if(!closed)await publish({description:{type:"offer",sdp:offer.sdp}});
      });
    },
    update(value:VideoSignal){
      return enqueue(async()=>{
        const description=input.guest?value.offer:value.answer;
        if(description?.sdp&&description.sdp!==remoteDescription){
          const expected=input.guest?"offer":"answer";
          if(description.type!==expected||description.sdp.length>48000)throw new Error("영상 연결 정보가 올바르지 않습니다.");
          await peer.setRemoteDescription(description);if(closed)return;remoteDescription=description.sdp;
          if(input.guest){const answer=await peer.createAnswer();if(closed)return;await peer.setLocalDescription(answer);if(!closed)await publish({description:{type:"answer",sdp:answer.sdp}});}
        }
        received.push(...(input.guest?value.viewerCandidates:value.guestCandidates)??[]);
        if(received.length>64)throw new Error("네트워크 연결 정보가 너무 많습니다.");
        if(!remoteDescription)return;
        for(const candidate of received.splice(0)){
          if(closed)return;
          const key=JSON.stringify(candidate);if(seen.has(key))continue;
          await peer.addIceCandidate(candidate);seen.add(key);
        }
      });
    },
    async camera(track:MediaStreamTrack){
      if(closed)throw new Error("상담이 종료되었습니다.");
      const sender=peer.getSenders().find(value=>value.track?.kind==="video");
      if(!sender)throw new Error("카메라 연결이 준비되지 않았습니다.");
      await sender.replaceTrack(track);
    },
    close(){
      if(closed)return;closed=true;controller.abort();received=[];seen.clear();
      incoming.getTracks().forEach(track=>track.stop());
      peer.onicecandidate=null;peer.ontrack=null;peer.onconnectionstatechange=null;peer.close();
    },
  };
}
