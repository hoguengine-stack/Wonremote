import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const VIDEO_INVITE_MS = 15 * 60_000;
export const VIDEO_ROOM_MS = 60 * 60_000;
export const VIDEO_MAX_CANDIDATES = 32;
export type VideoDescription = {type:"offer"|"answer";sdp:string};
export type VideoCandidate = {candidate:string;sdpMid:string|null;sdpMLineIndex:number|null};
export interface VideoRoom extends Record<string, unknown> {
  id:string;ownerUid:string;inviteHash:string;guestHash?:string;createdAt:number;
  inviteExpiresAt:number;expiresAt:number;state:"waiting"|"joined"|"ended";
  smsState:"none"|"sending"|"accepted"|"unknown";offer?:VideoDescription;answer?:VideoDescription;
  viewerCandidates:VideoCandidate[];guestCandidates:VideoCandidate[];
}
export interface VideoTransaction {
  get(path:string):Promise<Record<string,unknown>|undefined>;
  put(path:string,value:Record<string,unknown>):void;
}
export interface VideoStore {
  transact<T>(action:(tx:VideoTransaction)=>Promise<T>):Promise<T>;
  watch(id:string,next:(room:VideoRoom|undefined)=>void,error:()=>void):()=>void;
}
export class VideoError extends Error {
  constructor(public status:number,message:string){super(message);}
}
export function videoHash(value:string){return createHash("sha256").update(value).digest("hex");}
function equalHash(value:string,hash:string){
  return /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(videoHash(value),"hex"),Buffer.from(hash,"hex"));
}
export function videoInput(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new VideoError(400,"잘못된 영상상담 요청입니다.");
  return value as Record<string,unknown>;
}
function token(value:unknown):string{
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new VideoError(403,"초대 정보를 확인할 수 없습니다.");
  return value;
}
export function videoRoomId(value:unknown):string{
  if(typeof value!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))throw new VideoError(400,"잘못된 상담 번호입니다.");
  return value;
}
export function videoLink(origin:string,id:string,inviteToken:string){
  const url=new URL("/video-support",origin);url.hash=new URLSearchParams({room:id,token:inviteToken}).toString();return url.toString();
}
export function assertVideoAccess(room:VideoRoom|undefined,owner:string|null,input:Record<string,unknown>,now:number,joining=false,allowEnded=false):VideoRoom{
  if(!room||(!allowEnded&&room.state==="ended")||room.expiresAt<=now)throw new VideoError(410,"종료되었거나 만료된 영상상담입니다.");
  if(owner){if(room.ownerUid!==owner)throw new VideoError(403,"다른 상담원의 영상상담입니다.");return room;}
  if(!equalHash(token(input.token),room.inviteHash))throw new VideoError(403,"초대 정보를 확인할 수 없습니다.");
  const key=token(input.guestKey);
  if(room.guestHash){if(!equalHash(key,room.guestHash))throw new VideoError(409,"이미 다른 기기에서 사용 중인 초대입니다.");}
  else if(!joining||room.inviteExpiresAt<=now)throw new VideoError(410,"초대가 만료되었거나 시작되지 않았습니다.");
  return room;
}
export function publicVideoRoom(room:VideoRoom){
  return {id:room.id,state:room.state,expiresAt:room.expiresAt,smsState:room.smsState,offer:room.offer,answer:room.answer,
    viewerCandidates:room.viewerCandidates,guestCandidates:room.guestCandidates};
}
export function createVideoService(store:VideoStore,options:{origin:string;inviteSecret:string;now?:()=>number;rtc:(identity:string)=>unknown;sms?: (to:string,link:string)=>Promise<void>}){
  if(options.inviteSecret.length<32)throw new VideoError(412,"영상상담 초대 서버가 설정되지 않았습니다.");
  const now=options.now??Date.now;
  const path=(id:string)=>`videoConsultations/${id}`;
  async function execute(owner:string|null,raw:unknown):Promise<Record<string,unknown>>{
    const input=videoInput(raw),action=input.action,id=videoRoomId(input.roomId);
    const inviteToken=createHmac("sha256",options.inviteSecret).update(id).digest("base64url");
    // Reject random guest probes before a billable database lookup.
    if(!owner&&!equalHash(token(input.token),videoHash(inviteToken)))throw new VideoError(403,"초대 정보를 확인할 수 없습니다.");
    if(action==="create"){
      if(!owner)throw new VideoError(401,"Viewer 로그인이 필요합니다.");
      return store.transact(async tx=>{
        const previous=await tx.get(path(id)) as VideoRoom|undefined;
        if(previous){assertVideoAccess(previous,owner,input,now());if(!equalHash(inviteToken,previous.inviteHash))throw new VideoError(409,"다른 초대 번호입니다.");return {roomId:id,link:videoLink(options.origin,id,inviteToken),expiresAt:previous.expiresAt,inviteExpiresAt:previous.inviteExpiresAt,rtc:options.rtc(owner)};}
        const quotaPath=`videoConsultationQuotas/${owner}`,quota=await tx.get(quotaPath);
        const active=typeof quota?.activeRoom==="string"?await tx.get(path(quota.activeRoom)) as VideoRoom|undefined:undefined;
        if(active&&active.state!=="ended"&&active.expiresAt>now())throw new VideoError(409,"열린 영상상담을 먼저 종료해 주세요.");
        const windowStart=typeof quota?.windowStart==="number"&&now()-quota.windowStart<VIDEO_ROOM_MS?quota.windowStart:now();
        const count=windowStart===quota?.windowStart?Number(quota.count):0;
        if(count>=10)throw new VideoError(429,"영상상담 생성 한도에 도달했습니다. 잠시 후 다시 시도하세요.");
        const room:VideoRoom={id,ownerUid:owner,inviteHash:videoHash(inviteToken),createdAt:now(),inviteExpiresAt:now()+VIDEO_INVITE_MS,expiresAt:now()+VIDEO_ROOM_MS,
          state:"waiting",smsState:"none",viewerCandidates:[],guestCandidates:[],purgeAt:new Date(now()+VIDEO_ROOM_MS+24*60*60_000)};
        tx.put(path(id),room);tx.put(quotaPath,{activeRoom:id,windowStart,count:count+1});
        return {roomId:id,link:videoLink(options.origin,id,inviteToken),expiresAt:room.expiresAt,inviteExpiresAt:room.inviteExpiresAt,rtc:options.rtc(owner)};
      });
    }
    if(action==="sms"){
      if(!owner)throw new VideoError(401,"Viewer 로그인이 필요합니다.");
      if(!options.sms)throw new VideoError(412,"문자 발송 업체·API 키·발신번호가 서버에 설정되지 않았습니다. 링크 복사를 이용하세요.");
      const number=typeof input.phone==="string"?input.phone.replace(/[ -]/g,""):"";
      if(!/^01[016789]\d{7,8}$/.test(number))throw new VideoError(400,"휴대폰 번호를 확인해 주세요.");
      if(!equalHash(token(input.token),videoHash(inviteToken)))throw new VideoError(403,"잘못된 초대 링크입니다.");
      const reserved=await store.transact(async tx=>{
        const room=assertVideoAccess(await tx.get(path(id)) as VideoRoom|undefined,owner,input,now());
        if(!equalHash(inviteToken,room.inviteHash)||room.inviteExpiresAt<=now())throw new VideoError(410,"초대 링크가 만료되었습니다.");
        if(room.smsState!=="none")return false;
        tx.put(path(id),{...room,smsState:"sending"});return true;
      });
      if(!reserved)throw new VideoError(409,"이미 문자 발송을 요청했습니다. 중복 발송하지 않습니다.");
      let state:"accepted"|"unknown"="accepted";
      try{await options.sms(number,videoLink(options.origin,id,inviteToken));}catch{state="unknown";}
      await store.transact(async tx=>{const room=await tx.get(path(id)) as VideoRoom|undefined;if(room)tx.put(path(id),{...room,smsState:state});});
      if(state==="unknown")throw new VideoError(502,"문자 접수 결과를 확인하지 못했습니다. 중복 과금을 막기 위해 자동 재전송하지 않습니다. 링크 복사를 이용하세요.");
      return {smsState:state};
    }
    return store.transact(async tx=>{
      const room=assertVideoAccess(await tx.get(path(id)) as VideoRoom|undefined,owner,input,now(),action==="join",action==="end");
      if(action==="join"){
        if(owner)throw new VideoError(400,"고객 초대 링크로 시작해 주세요.");
        if(!room.guestHash)tx.put(path(id),{...room,guestHash:videoHash(token(input.guestKey)),state:"joined"});
        return {roomId:id,expiresAt:room.expiresAt,rtc:options.rtc(`video-${id}`)};
      }
      if(action==="watch")return {expiresAt:room.expiresAt};
      if(action==="end"){
        if(room.state!=="ended"){
          const {offer,answer,...metadata}=room;
          tx.put(path(id),{...metadata,state:"ended",viewerCandidates:[],guestCandidates:[]});
        }
        return {ended:true};
      }
      if(action!=="signal")throw new VideoError(400,"지원하지 않는 영상상담 요청입니다.");
      if(input.description!==undefined){
        const d=videoInput(input.description),type=owner?"offer":"answer";
        if(d.type!==type||typeof d.sdp!=="string"||!d.sdp.startsWith("v=0")||d.sdp.length>48000)throw new VideoError(400,"잘못된 영상 연결 정보입니다.");
        const old=room[type];
        if(old&&old.sdp!==d.sdp)throw new VideoError(409,"이미 처리된 연결입니다. 새 상담을 시작해 주세요.");
        if(!old)tx.put(path(id),{...room,[type]:{type,sdp:d.sdp}});
      }else{
        const c=videoInput(input.candidate);
        if(typeof c.candidate!=="string"||c.candidate.length>2048||!c.candidate.startsWith("candidate:")
          ||(c.sdpMid!==null&&(typeof c.sdpMid!=="string"||c.sdpMid.length>32))
          ||(c.sdpMLineIndex!==null&&(!Number.isInteger(c.sdpMLineIndex)||Number(c.sdpMLineIndex)<0||Number(c.sdpMLineIndex)>8)))throw new VideoError(400,"잘못된 네트워크 연결 정보입니다.");
        const field=owner?"viewerCandidates":"guestCandidates",list=room[field];
        const candidate={candidate:c.candidate,sdpMid:c.sdpMid,sdpMLineIndex:c.sdpMLineIndex} as VideoCandidate;
        if(!list.some(item=>JSON.stringify(item)===JSON.stringify(candidate))){
          if(list.length>=VIDEO_MAX_CANDIDATES)throw new VideoError(429,"네트워크 연결 정보 한도를 초과했습니다.");
          tx.put(path(id),{...room,[field]:[...list,candidate]});
        }
      }
      return {ok:true};
    });
  }
  return {execute,store,now};
}
