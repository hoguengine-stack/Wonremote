import { resolveFirebaseConfig } from "../firebase/firebaseConfig";

export const DEFAULT_VIDEO_CONSULTATION_URL="https://wonremote-video-consultation.qpalzm8178.workers.dev/videoConsultation";

export type VideoSignal = {
  state:"waiting"|"joined"|"ended";expiresAt?:number;smsState?:string;message?:string;
  offer?:RTCSessionDescriptionInit;answer?:RTCSessionDescriptionInit;
  viewerCandidates?:RTCIceCandidateInit[];guestCandidates?:RTCIceCandidateInit[];
};
export type VideoInvitation = {roomId:string;link:string;inviteExpiresAt:number;expiresAt:number;rtc:RTCConfiguration;smsAvailable?:boolean;smsRoutingAvailable?:boolean};
export interface VideoApi {
  call(action:string,roomId:string,data:Record<string,unknown>,signal?:AbortSignal):Promise<any>;
  watch(roomId:string,onUpdate:(value:VideoSignal)=>void,signal:AbortSignal):Promise<void>;
}
export function readVideoInvite(hash:string):{roomId:string;token:string}|null{
  const params=new URLSearchParams(hash.replace(/^#/,"")),roomId=params.get("room"),token=params.get("token");
  return roomId&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(roomId)&&token&&/^[A-Za-z0-9_-]{43}$/.test(token)?{roomId,token}:null;
}
export function videoGuestKey(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
export function createVideoApi(guest?:{token:string;guestKey:string}):VideoApi{
  const config=resolveFirebaseConfig(import.meta.env);
  const project=config?.projectId;
  const configured=import.meta.env.VITE_WONREMOTE_VIDEO_API_URL?.trim();
  const endpoint=configured??(project==="wonremote-a7fd3"?DEFAULT_VIDEO_CONSULTATION_URL:`https://us-central1-${project}.cloudfunctions.net/videoConsultation`);
  async function request(action:string,roomId:string,data:Record<string,unknown>,signal?:AbortSignal){
    if(!project)throw new Error("영상상담 서버가 설정되지 않았습니다.");
    const url=new URL(endpoint);
    if(url.username||url.password||url.search||url.hash||(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname))))throw new Error("영상상담 서버 주소가 올바르지 않습니다.");
    const headers:Record<string,string>={"Content-Type":"application/json"};
    if(!guest){
      const {getWonRemoteFirebaseServices}=await import("../firebase/firebaseServices");
      const user=getWonRemoteFirebaseServices(config!).auth.currentUser;
      if(!user)throw new Error("Viewer 로그인이 필요합니다.");
      headers.Authorization=`Bearer ${await user.getIdToken(action==="watch")}`;
    }
    if(signal?.aborted)throw new DOMException("취소되었습니다.","AbortError");
    const response=await fetch(endpoint,{method:"POST",headers,credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer",signal,
      body:JSON.stringify({...data,...guest,action,roomId})});
    if(!response.ok){const error=await response.json().catch(()=>null);throw new Error(typeof error?.error==="string"?error.error:"영상상담 서버에 연결하지 못했습니다.");}
    return response;
  }
  return {
    async call(action,roomId,data,signal){
      const controller=new AbortController(),abort=()=>controller.abort();
      signal?.addEventListener("abort",abort,{once:true});
      const timer=setTimeout(abort,20_000);
      try{if(signal?.aborted)controller.abort();return await (await request(action,roomId,data,controller.signal)).json();}
      finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
    },
    async watch(roomId,onUpdate,signal){
      const response=await request("watch",roomId,{},signal);
      if(!response.headers.get("content-type")?.includes("text/event-stream")||!response.body)throw new Error("상담 상태 연결을 열지 못했습니다.");
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending="";
      try{
        while(!signal.aborted){
          const {value,done}=await reader.read();if(done)break;
          pending+=decoder.decode(value,{stream:true});
          if(pending.length>160_000)throw new Error("상담 상태 크기가 잘못되었습니다.");
          let end:number;
          while((end=pending.indexOf("\n\n"))>=0){
            const event=pending.slice(0,end);pending=pending.slice(end+2);
            if(!event.startsWith("data: "))continue;
            const update=JSON.parse(event.slice(6)) as VideoSignal;
            if(!update||!["waiting","joined","ended"].includes(update.state))throw new Error("상담 상태가 올바르지 않습니다.");
            if(!signal.aborted)onUpdate(update);
            if(update.state==="ended")return;
          }
        }
        if(!signal.aborted)throw new Error("상담 상태 연결이 끊겼습니다. 상담을 다시 시작해 주세요.");
      }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    },
  };
}
