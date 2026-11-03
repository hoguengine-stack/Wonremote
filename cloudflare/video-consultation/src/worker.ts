import type { DurableObjectState } from "@cloudflare/workers-types";
import { assertVideoAccess, createVideoService, publicVideoRoom, VideoError, videoHash, videoInput, videoRoomId, type VideoRoom, type VideoStore } from "../../../functions/src/videoConsultationCore";
import { verifyVideoViewer, type VideoIdentity } from "./auth";
import { limitedJson, videoFailure } from "./http";
import { cloudflareTurn } from "./turn";
import { createSmsGateway, smsActions } from "./sms";

export interface Env {
  FIREBASE_PROJECT_ID:string;FIREBASE_WEB_API_KEY:string;BOOTSTRAP_VIEWER_UID:string;PUBLIC_ORIGIN:string;
  VIDEO_INVITE_SECRET:string;CLOUDFLARE_TURN_KEY_ID:string;CLOUDFLARE_TURN_API_TOKEN:string;
  VIDEO_ROOMS:{idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
}

const apiPath="/videoConsultation";
function allowedOrigin(origin:string,env:Env){
  return [env.PUBLIC_ORIGIN,"https://wonremote-a7fd3.firebaseapp.com","http://tauri.localhost","https://tauri.localhost","tauri://localhost"].includes(origin)||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
export async function handleVideoRequest(request:Request,env:Env,authenticate=verifyVideoViewer){
  const origin=request.headers.get("Origin");let response:Response;
  try{
    const url=new URL(request.url);
    if(url.pathname!==apiPath)throw new VideoError(404,"영상상담 주소를 확인해 주세요.");
    if(origin&&!allowedOrigin(origin,env))throw new VideoError(403,"허용되지 않은 영상상담 출처입니다.");
    if(request.method==="OPTIONS"){
      if(request.headers.get("Access-Control-Request-Method")!=="POST")throw new VideoError(405,"POST 요청만 지원합니다.");
      const headers=(request.headers.get("Access-Control-Request-Headers")??"").toLowerCase().split(",").map(v=>v.trim()).filter(Boolean);
      if(headers.some(value=>!["content-type","authorization"].includes(value)))throw new VideoError(403,"허용되지 않은 요청 헤더입니다.");
      response=new Response(null,{status:204,headers:{"Access-Control-Allow-Methods":"POST","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Max-Age":"3600"}});
    }else{
      if(request.method!=="POST")throw new VideoError(405,"POST 요청만 지원합니다.");
      if(!request.headers.get("Content-Type")?.startsWith("application/json"))throw new VideoError(415,"JSON 요청이 필요합니다.");
      const body=videoInput(await limitedJson(request.body,100_000)),smsSettings=smsActions.includes(String(body.action));
      if(!smsSettings)videoRoomId(body.roomId);
      if(!smsSettings&&!["create","join","signal","watch","end","sms"].includes(String(body.action)))throw new VideoError(400,"지원하지 않는 영상상담 요청입니다.");
      let identity:VideoIdentity|null=null;
      const authorization=request.headers.get("Authorization");
      if(authorization)identity=await authenticate(authorization,env);
      else if(smsSettings||body.action==="create"||body.action==="sms")throw new VideoError(401,"Viewer 로그인이 필요합니다.");
      // This binding is private. Never forward user-supplied identity headers to it.
      const headers=new Headers({"Content-Type":"application/json"});
      if(identity){headers.set("X-Video-Owner",identity.uid);headers.set("X-Video-Auth-Expiry",String(identity.expiresAt));}
      response=await env.VIDEO_ROOMS.get(env.VIDEO_ROOMS.idFromName("consultations-v1")).fetch(new Request(`https://video.internal${apiPath}`,{method:"POST",headers,body:JSON.stringify(body)}));
    }
  }catch(error){response=videoFailure(error);}
  const headers=new Headers(response.headers);headers.set("Cache-Control","no-store");headers.set("Referrer-Policy","no-referrer");headers.set("Vary","Origin");
  if(origin&&allowedOrigin(origin,env))headers.set("Access-Control-Allow-Origin",origin);
  return new Response(response.body,{status:response.status,headers});
}
export default {fetch:(request:Request,env:Env)=>handleVideoRequest(request,env)};

type Watch={send:(room:VideoRoom)=>void;close:(message?:string)=>void};
export class VideoRooms {
  private queue:Promise<unknown>=Promise.resolve();
  private pendingSms=new Set<string>();
  private watches=new Map<string,Watch>();
  constructor(private ctx:Pick<DurableObjectState,"storage">,private env:Env){}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{
    const result=this.queue.then(operation);this.queue=result.catch(()=>undefined);return result;
  }
  async fetch(request:Request){
    try{
      const input=videoInput(await limitedJson(request.body,100_000));
      const owner=request.headers.get("X-Video-Owner"),authExpiry=Number(request.headers.get("X-Video-Auth-Expiry"));
      if(owner&&(!Number.isFinite(authExpiry)||authExpiry<=Date.now()))throw new VideoError(401,"Viewer 로그인이 만료되었습니다.");
      const sms=createSmsGateway(this.ctx.storage,this.env.VIDEO_INVITE_SECRET??"");
      if(smsActions.includes(String(input.action))){
        if(!owner)throw new VideoError(401,"Viewer 로그인이 필요합니다.");
        return Response.json(await sms.execute(owner,input));
      }
      const id=videoRoomId(input.roomId);
      const operation=async()=>{
      if(owner&&authExpiry<=Date.now())throw new VideoError(401,"Viewer 로그인이 만료되었습니다.");
      const store:VideoStore={watch:()=>{throw new Error("Streams are owned by the coordinator");},transact:async action=>{
        let committed=new Map<string,Record<string,unknown>>();
        const result=await this.ctx.storage.transaction(async tx=>{
          const writes=new Map<string,Record<string,unknown>>(),absent=new Set<string>();
          const value=await action({get:async path=>{const stored=await tx.get<Record<string,unknown>>(path);if(!stored)absent.add(path);return stored;},put:(path,doc)=>{writes.set(path,doc);}});
          for(const [path,doc] of writes){
            await tx.put(path,doc);
            if(path.startsWith("videoConsultations/")&&absent.has(path)){
              const purgeAt=new Date(doc.purgeAt as Date).getTime();
              await tx.put(`purge/${purgeAt}/${doc.id}`,path);
              const alarm=await tx.getAlarm();if(alarm===null||alarm>purgeAt)await tx.setAlarm(purgeAt);
            }
          }
          committed=writes;return value;
        });
        for(const [path,room] of committed)if(path.startsWith("videoConsultations/"))for(const role of ["owner","guest"])this.watches.get(`${room.id}/${role}`)?.send(room as VideoRoom);
        return result;
      }};
      let sendSms:((to:string,link:string)=>Promise<void>)|undefined;
      if(input.action==="sms"&&input.smsMode!==undefined){
        if(!owner)throw new VideoError(401,"Viewer 로그인이 필요합니다.");
        const room=assertVideoAccess(await this.ctx.storage.get<VideoRoom>(`videoConsultations/${id}`),owner,input,Date.now());
        if(typeof input.token!=="string"||videoHash(input.token)!==room.inviteHash)throw new VideoError(403,"초대 정보를 확인할 수 없습니다.");
        if(room.smsState!=="none")throw new VideoError(409,"이미 문자 발송을 요청했습니다. 중복 발송하지 않습니다.");
        if(room.inviteExpiresAt<=Date.now())throw new VideoError(410,"초대가 만료되었습니다.");
        if(typeof input.phone!=="string"||!/^01[016789]\d{7,8}$/.test(input.phone.replace(/[ -]/g,"")))throw new VideoError(400,"휴대폰 번호를 확인해 주세요.");
        sendSms=await sms.prepare(owner,input);
      }
      const service=createVideoService(store,{origin:this.env.PUBLIC_ORIGIN,inviteSecret:this.env.VIDEO_INVITE_SECRET??"",rtc:()=>cloudflareTurn(this.env.CLOUDFLARE_TURN_KEY_ID??"",this.env.CLOUDFLARE_TURN_API_TOKEN??""),sms:sendSms});
      const result=await service.execute(owner,input);
      if(input.action==="watch"){
        const room=assertVideoAccess(await this.ctx.storage.get<VideoRoom>(`videoConsultations/${id}`),owner,input,Date.now());
        return this.stream(room,owner,input,owner?authExpiry:room.expiresAt);
      }
      return Response.json({...result,...(input.action==="create"?{smsAvailable:false,smsRoutingAvailable:true}:{})});
      };
      // Slow SMS providers must not hold the coordinator queue used by live video signaling.
      if(input.action==="sms"){
        if(!owner)throw new VideoError(401,"Viewer 로그인이 필요합니다.");
        if(this.pendingSms.has(id))throw new VideoError(409,"문자 발송을 처리 중입니다. 중복 발송하지 않습니다.");
        this.pendingSms.add(id);
        try{return await operation();}finally{this.pendingSms.delete(id);}
      }
      return await this.serial(operation);
    }catch(error){return videoFailure(error);}
  }
  private stream(room:VideoRoom,owner:string|null,input:Record<string,unknown>,authExpiry:number){
    const key=`${room.id}/${owner?"owner":"guest"}`;
    if(this.watches.has(key))throw new VideoError(409,"이미 상담 상태를 수신 중입니다.");
    const encoder=new TextEncoder();let ended=false,controller:ReadableStreamDefaultController<Uint8Array>;
    let timer:ReturnType<typeof setTimeout>,heartbeat:ReturnType<typeof setInterval>;
    let previousOffer="",previousAnswer="",viewerCount=0,guestCount=0;
    const cleanup=()=>{if(ended)return;ended=true;clearTimeout(timer);clearInterval(heartbeat);this.watches.delete(key);};
    const enqueue=(text:string)=>{if(ended)return false;if(controller.desiredSize!==null&&controller.desiredSize<=0){cleanup();controller.error(new Error("영상상담 수신이 지연되어 종료됐습니다."));return false;}controller.enqueue(encoder.encode(text));return true;};
    const close=(message="상담 종료")=>{if(ended)return;enqueue(`data: ${JSON.stringify({state:"ended",message})}\n\n`);if(ended)return;cleanup();controller.close();};
    const send=(value:VideoRoom)=>{
      if(ended)return;if(value.state==="ended"){close();return;}
      try{assertVideoAccess(value,owner,input,Date.now());}catch{close("영상상담 권한이 만료되었습니다.");return;}
      const data=publicVideoRoom(value);
      enqueue(`data: ${JSON.stringify({state:data.state,expiresAt:data.expiresAt,smsState:owner?data.smsState:undefined,
        offer:!owner&&data.offer?.sdp!==previousOffer?data.offer:undefined,answer:owner&&data.answer?.sdp!==previousAnswer?data.answer:undefined,
        viewerCandidates:owner?[]:data.viewerCandidates.slice(viewerCount),guestCandidates:owner?data.guestCandidates.slice(guestCount):[]})}\n\n`);
      previousOffer=data.offer?.sdp??"";previousAnswer=data.answer?.sdp??"";viewerCount=data.viewerCandidates.length;guestCount=data.guestCandidates.length;
    };
    const body=new ReadableStream<Uint8Array>({start:value=>{controller=value;},cancel:cleanup});
    this.watches.set(key,{send,close});
    timer=setTimeout(()=>close("영상상담 유효시간이 종료되었습니다."),Math.max(1,Math.min(room.expiresAt,authExpiry)-Date.now()));
    heartbeat=setInterval(()=>enqueue(": keepalive\n\n"),25_000);
    send(room);
    return new Response(body,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store"}});
  }
  alarm(){return this.serial(async()=>{
    const entries=await this.ctx.storage.list<string>({prefix:"purge/",limit:32});let next:number|undefined;const expired:string[]=[];
    for(const [index,path] of entries){const at=Number(index.split("/")[1]);if(at>Date.now()){next=at;break;}expired.push(index,path);}
    if(expired.length)await this.ctx.storage.delete(expired);
    if(next!==undefined)await this.ctx.storage.setAlarm(next);
    else if(entries.size===32)await this.ctx.storage.setAlarm(Date.now()+1000);
  });}
}
