import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import type { Response } from "express";
import { BOOTSTRAP_VIEWER_UID } from "./viewerAccounts.js";
import { createTemporaryTurnCredential } from "./turnCredentials.js";
import { assertVideoAccess, createVideoService, publicVideoRoom, VideoError, videoInput, videoRoomId, type VideoRoom, type VideoStore } from "./videoConsultationCore.js";
import { solapiVideoSms } from "./videoConsultationSms.js";

const configSecret=defineSecret("WONREMOTE_VIDEO_CONFIG");
const turnSecret=defineSecret("WONREMOTE_TURN_SHARED_SECRET");
const turnUrls=defineString("WONREMOTE_TURN_URLS",{default:""});
const publicOrigin=defineString("WONREMOTE_VIDEO_ORIGIN",{default:"https://wonremote-a7fd3.web.app"});

export function requireVideoViewer(claims:{uid:string;wonremoteViewer?:unknown;wonremoteAdmin?:unknown}){
  if(claims.uid!==BOOTSTRAP_VIEWER_UID&&claims.wonremoteViewer!==true)throw new VideoError(403,"Viewer 계정으로 로그인해 주세요.");
  return claims.uid;
}

export const videoConsultation=onRequest({
  region:"us-central1",timeoutSeconds:3600,maxInstances:20,secrets:[configSecret,turnSecret],
  cors:["https://wonremote-a7fd3.web.app","https://wonremote-a7fd3.firebaseapp.com","http://tauri.localhost","tauri://localhost",/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
},async(req,res)=>{
  res.set("Cache-Control","no-store");res.set("Referrer-Policy","no-referrer");
  try{
    if(req.method!=="POST")throw new VideoError(405,"POST 요청만 지원합니다.");
    if(JSON.stringify(req.body??null).length>100_000)throw new VideoError(413,"요청 크기를 초과했습니다.");
    const input=videoInput(req.body),roomId=videoRoomId(input.roomId);
    let owner:string|null=null,authExpiry=Date.now()+60*60_000;
    const authorization=req.get("Authorization");
    if(authorization){
      if(!authorization.startsWith("Bearer "))throw new VideoError(401,"Viewer 인증이 필요합니다.");
      const claims=await getAuth().verifyIdToken(authorization.slice(7),true).catch(()=>{throw new VideoError(401,"Viewer 로그인이 만료되었습니다.");});
      owner=requireVideoViewer(claims);authExpiry=claims.exp*1000;
    }
    const config=JSON.parse(configSecret.value()) as {inviteSecret:string;sms?:{provider:string;apiKey:string;apiSecret:string;from:string}};
    const db=getFirestore();
    const store:VideoStore={
      transact:action=>db.runTransaction(tx=>action({get:async path=>(await tx.get(db.doc(path))).data(),put:(path,value)=>{tx.set(db.doc(path),value);}})),
      watch:(id,next,error)=>db.doc(`videoConsultations/${id}`).onSnapshot(snapshot=>next(snapshot.data() as VideoRoom|undefined),error),
    };
    const service=createVideoService(store,{
      origin:publicOrigin.value(),inviteSecret:config.inviteSecret??"",
      rtc:identity=>{
        const urls=turnUrls.value().split(",").map(v=>v.trim()).filter(Boolean);
        if(!urls.length||!turnSecret.value())throw new VideoError(412,"영상 중계 서버가 설정되지 않았습니다.");
        const credential=createTemporaryTurnCredential({identity,secret:turnSecret.value(),ttlSeconds:3600});
        return {iceServers:[{urls:["stun:stun.l.google.com:19302"]},{urls,username:credential.username,credential:credential.credential}],iceTransportPolicy:"all"};
      },
      sms:config.sms?.provider==="solapi"?solapiVideoSms(config.sms):undefined,
    });
    const result=await service.execute(owner,input);
    if(input.action!=="watch"){res.json(result);return;}
    if(res.destroyed)return;
    streamVideoRoom(store,res,roomId,owner,input,Math.min(Number(result.expiresAt),authExpiry));
  }catch(error){
    if(res.headersSent){res.end();return;}
    const known=error instanceof VideoError;
    res.status(known?error.status:500).json({error:known?error.message:"영상상담 서버를 처리하지 못했습니다. 서버 설정을 확인해 주세요."});
  }
});

export function streamVideoRoom(store:VideoStore,res:Pick<Response,"set"|"flushHeaders"|"write"|"end"|"on"|"destroyed">,roomId:string,owner:string|null,input:Record<string,unknown>,deadline:number){
    let finished=false,unsubscribe:(()=>void)|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
    const cleanup=()=>{finished=true;unsubscribe?.();unsubscribe=undefined;clearTimeout(timer);clearInterval(heartbeat);};
    res.on("close",cleanup);
    res.set("Content-Type","text/event-stream");res.set("X-Accel-Buffering","no");res.flushHeaders();
    const close=(message:string)=>{if(!res.destroyed){res.write(`data: ${JSON.stringify({state:"ended",message})}\n\n`);res.end();}cleanup();};
    timer=setTimeout(()=>close("영상상담 유효시간이 종료되었습니다."),Math.max(1,deadline-Date.now()));
    // Keep idle proxies alive without database reads or client polling.
    heartbeat=setInterval(()=>{if(res.destroyed||!res.write(": keepalive\n\n")){res.end();cleanup();}},25_000);
    let previousOffer="",previousAnswer="",viewerCount=0,guestCount=0;
    try{unsubscribe=store.watch(roomId,room=>{
      if(finished||res.destroyed){cleanup();return;}
      if(!room||room.state==="ended"){close("영상상담이 종료되었습니다.");return;}
      try{assertVideoAccess(room,owner,input,Date.now());}catch{close("영상상담 권한이 만료되었습니다.");return;}
      const value=publicVideoRoom(room);
      // Send only newly observed SDP/candidates, not the full growing signal document.
      const update={state:value.state,expiresAt:value.expiresAt,smsState:owner?value.smsState:undefined,
        offer:!owner&&value.offer?.sdp!==previousOffer?value.offer:undefined,answer:owner&&value.answer?.sdp!==previousAnswer?value.answer:undefined,
        viewerCandidates:owner?[]:value.viewerCandidates.slice(viewerCount),guestCandidates:owner?value.guestCandidates.slice(guestCount):[]};
      previousOffer=value.offer?.sdp??"";previousAnswer=value.answer?.sdp??"";viewerCount=value.viewerCandidates.length;guestCount=value.guestCandidates.length;
      if(!res.write(`data: ${JSON.stringify(update)}\n\n`)){res.end();cleanup();}
    },()=>close("상담 상태를 수신하지 못했습니다."));}catch(error){cleanup();throw error;}
    if(finished||res.destroyed)cleanup();
}
