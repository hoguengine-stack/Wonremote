import { Copy, Flashlight, FlashlightOff, PhoneOff, Send, SwitchCamera, Video, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { createVideoApi, readVideoInvite, videoGuestKey, type VideoApi, type VideoInvitation, type VideoSignal } from "../api/videoConsultationApi";
import { createVideoPeer } from "../domain/videoConsultationPeer";
import { VideoSmsSettings } from "./VideoSmsSettings";
import { readVideoSmsSelection, videoSmsPhoneStatus, type VideoSmsPhone, type VideoSmsSelection } from "../domain/videoSms";

type GuestInvite=NonNullable<ReturnType<typeof readVideoInvite>>;
function supportsTorch(track?:MediaStreamTrack){
  try{const value=(track?.getCapabilities() as MediaTrackCapabilities&{torch?:boolean|boolean[]}|undefined)?.torch;return Array.isArray(value)?value.includes(true)&&value.includes(false):value===true;}catch{return false;}
}
export function VideoConsultation({guest,onClose,api:injectedApi}:{guest?:GuestInvite;onClose?:()=>void;api?:VideoApi}){
  const [key]=useState(()=>guest?videoGuestKey():"");
  const [api]=useState(()=>injectedApi??createVideoApi(guest?{token:guest.token,guestKey:key}:undefined));
  const [invitation,setInvitation]=useState<VideoInvitation|null>(null);
  const [phone,setPhone]=useState(""),[status,setStatus]=useState(guest?"시작 대기":"새 상담"),[error,setError]=useState("");
  const [busy,setBusy]=useState(false),[smsState,setSmsState]=useState("none"),[ended,setEnded]=useState(false),[playBlocked,setPlayBlocked]=useState(false);
  const [torch,setTorch]=useState(false),[torchAvailable,setTorchAvailable]=useState(false);
  const [hasPicture,setHasPicture]=useState(false);
  const [smsSelection,setSmsSelection]=useState<VideoSmsSelection|null>(null),[senderPhone,setSenderPhone]=useState<VideoSmsPhone|null>(null);
  const live=useRef(true),operation=useRef(false),roomId=useRef(guest?.roomId??"");
  const generation=useRef(0),admitted=useRef(false);
  const deadline=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const controller=useRef<AbortController|null>(null),peer=useRef<ReturnType<typeof createVideoPeer>|null>(null);
  const smsRouteController=useRef<AbortController|null>(null);
  const local=useRef<MediaStream|null>(null),front=useRef(false);
  const remoteVideo=useRef<HTMLVideoElement|null>(null),localVideo=useRef<HTMLVideoElement|null>(null);
  const modal=useRef<HTMLElement|null>(null);
  function stop(){
    generation.current++;
    clearTimeout(deadline.current);deadline.current=undefined;
    controller.current?.abort();controller.current=null;peer.current?.close();peer.current=null;
    smsRouteController.current?.abort();smsRouteController.current=null;
    local.current?.getTracks().forEach(track=>track.stop());local.current=null;
    for(const element of [remoteVideo.current,localVideo.current])if(element){element.pause();element.srcObject=null;}
  }
  async function closeRoom(){
    if(!admitted.current)return;
    admitted.current=false;
    await api.call("end",roomId.current,{});
  }
  function fail(cause:unknown){
    const wasAdmitted=admitted.current;
    stop();
    void closeRoom().catch(()=>undefined);
    if(live.current){setError(cause instanceof Error?cause.message:"영상상담에 실패했습니다.");setStatus("연결 중단");setEnded(wasAdmitted);setBusy(false);}
  }
  useEffect(()=>{
    live.current=true;const previous=document.activeElement as HTMLElement|null;
    modal.current?.querySelector<HTMLElement>("input,button")?.focus();
    return ()=>{
      live.current=false;stop();
      void closeRoom().catch(()=>undefined);
      previous?.focus();
    };
  },[api]);
  function play(element:HTMLMediaElement|null){if(element)void element.play().then(()=>{if(live.current)setPlayBlocked(false);},()=>{if(live.current)setPlayBlocked(true);});}
  async function connect(created:VideoInvitation,stream?:MediaStream){
    if(!live.current){stream?.getTracks().forEach(track=>track.stop());return;}
    const active=new AbortController();controller.current=active;let joining=Boolean(guest),connected=false;
    const connectionDeadline=()=>{
      clearTimeout(deadline.current);
      deadline.current=setTimeout(()=>fail(new Error("영상 연결 시간이 초과되었습니다. 새 상담 링크로 다시 시작해 주세요.")),45_000);
    };
    if(guest)connectionDeadline();
    else deadline.current=setTimeout(()=>fail(new Error("초대 유효시간이 지났습니다. 새 상담 링크를 만들어 주세요.")),Math.max(1,created.inviteExpiresAt-Date.now()));
    const connection=createVideoPeer({guest:Boolean(guest),roomId:created.roomId,api,configuration:created.rtc,stream,
      onStream:incoming=>{
        const target=guest?null:remoteVideo.current;
        if(target){target.srcObject=incoming;play(target);}
      },
      onState:state=>{
        if(!live.current)return;
        if(state==="connected"){connected=true;clearTimeout(deadline.current);setStatus("상담 중");}
        if(state==="failed"||state==="closed"||state==="disconnected")fail(new Error("영상 연결이 끊겼습니다. 상담을 종료하고 새 링크로 다시 시작해 주세요."));
      },onError:fail});
    peer.current=connection;
    await connection.start();
    if(active.signal.aborted)return;
    void api.watch(created.roomId,(value:VideoSignal)=>{
      if(active.signal.aborted||!live.current)return;
      if(value.state==="ended"){admitted.current=false;stop();setEnded(true);setStatus(value.message??"상담 종료");return;}
      if(value.smsState)setSmsState(value.smsState);
      if(value.state==="joined"){
        if(!joining){joining=true;if(!connected)connectionDeadline();}
        setStatus(previous=>previous==="상담 중"?previous:"영상 연결 중");
      }
      void connection.update(value);
    },active.signal).catch(cause=>{if(!active.signal.aborted)fail(cause);});
  }
  async function begin(){
    if(operation.current||ended||peer.current)return;
    operation.current=true;setBusy(true);setError("");
    const epoch=generation.current;
    try{
      if(guest){
        setStatus("카메라 확인 중");
        if(!navigator.mediaDevices?.getUserMedia)throw new Error("카메라를 사용할 수 없습니다. HTTPS 주소를 Chrome 또는 Safari에서 열어 주세요.");
        const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});
        if(!live.current||epoch!==generation.current){stream.getTracks().forEach(track=>track.stop());return;}
        local.current=stream;front.current=stream.getVideoTracks()[0]?.getSettings().facingMode==="user";
        setTorch(false);setTorchAvailable(supportsTorch(stream.getVideoTracks()[0]));
        if(localVideo.current){localVideo.current.srcObject=stream;play(localVideo.current);}
        const result=await api.call("join",guest.roomId,{});
        if(!live.current||epoch!==generation.current){void api.call("end",guest.roomId,{}).catch(()=>undefined);return;}
        admitted.current=true;
        setStatus("영상 연결 중");await connect({...result,link:"",inviteExpiresAt:0},stream);
      }else{
        const id=roomId.current||crypto.randomUUID();roomId.current=id;setStatus("초대 생성 중");
        const created=await api.call("create",id,{}) as VideoInvitation;
        if(!live.current||epoch!==generation.current){void api.call("end",id,{}).catch(()=>undefined);return;}
        admitted.current=true;
        setInvitation(created);setStatus("고객 접속 대기");setSenderPhone(null);
        if(created.smsRoutingAvailable){
          try{
            const selection=readVideoSmsSelection(),active=new AbortController();smsRouteController.current=active;setSmsSelection(selection);
            void api.call("sms-route","",selection,active.signal).then(result=>{
              if(live.current&&!active.signal.aborted&&epoch===generation.current)setSenderPhone(result.phone);
            }).catch(()=>{if(live.current&&!active.signal.aborted)setSenderPhone(null);});
          }catch{setSmsSelection(null);}
        }
        await connect(created);
      }
    }catch(cause){
      const denied=cause instanceof DOMException&&["NotAllowedError","PermissionDeniedError"].includes(cause.name);
      fail(denied?new Error("카메라 권한을 허용한 뒤 다시 시작해 주세요. 차단한 경우 브라우저 사이트 설정에서 변경할 수 있습니다."):cause);
    }finally{operation.current=false;if(live.current)setBusy(false);}
  }
  async function sendSms(){
    if(operation.current||!invitation||smsState!=="none"||(invitation.smsRoutingAvailable&&(!smsSelection||!senderPhone?.ready)))return;
    operation.current=true;setBusy(true);setError("");
    const token=readVideoInvite(new URL(invitation.link).hash)?.token;
    try{await api.call("sms",invitation.roomId,{phone,token,...(invitation.smsRoutingAvailable?smsSelection:{})});if(live.current)setSmsState("accepted");}
    catch(cause){if(live.current)setError(cause instanceof Error?cause.message:"문자를 전송하지 못했습니다.");}
    finally{operation.current=false;if(live.current)setBusy(false);}
  }
  async function toggleTorch(){
    const track=local.current?.getVideoTracks()[0];
    if(operation.current||!track||!supportsTorch(track))return;
    operation.current=true;setBusy(true);setError("");const epoch=generation.current,next=!torch;
    try{
      await track.applyConstraints({advanced:[{torch:next} as MediaTrackConstraintSet&{torch:boolean}]});
      if(!live.current||epoch!==generation.current||track!==local.current?.getVideoTracks()[0])return;
      const actual=(track.getSettings() as MediaTrackSettings&{torch?:boolean}).torch;
      if(typeof actual==="boolean"&&actual!==next)throw new Error("Torch setting not applied");
      setTorch(next);
    }catch{if(live.current&&epoch===generation.current)setError("후레쉬를 변경하지 못했습니다. 카메라 영상은 계속 공유됩니다.");}
    finally{operation.current=false;if(live.current)setBusy(false);}
  }
  async function switchCamera(){
    if(operation.current||!peer.current||!local.current)return;operation.current=true;setError("");const epoch=generation.current;
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:front.current?"environment":"user"}},audio:false});
      const track=stream.getVideoTracks()[0];
      if(!live.current||!peer.current||!local.current||epoch!==generation.current){stream.getTracks().forEach(value=>value.stop());return;}
      try{await peer.current.camera(track);if(!live.current||!local.current||epoch!==generation.current){stream.getTracks().forEach(value=>value.stop());return;}const old=local.current.getVideoTracks();old.forEach(value=>{local.current?.removeTrack(value);value.stop();});local.current.addTrack(track);front.current=!front.current;setTorch(false);setTorchAvailable(supportsTorch(track));}
      catch(cause){stream.getTracks().forEach(value=>value.stop());throw cause;}
    }catch{if(live.current)setError("이 기기에서는 카메라를 전환하지 못했습니다. 현재 카메라는 유지됩니다.");}
    finally{operation.current=false;}
  }
  async function end(){
    stop();setEnded(true);setTorch(false);setTorchAvailable(false);setStatus("상담 종료");
    try{await closeRoom();}
    catch{if(live.current)setError("이 기기 송출은 중지됐지만 서버 종료 확인에 실패했습니다. 링크 만료 전에는 다시 공유하지 마세요.");}
  }
  return <section ref={modal} className={`video-consultation${guest?" video-consultation-guest":""}`} role={guest?undefined:"dialog"} aria-modal={guest?undefined:true} aria-labelledby="video-consultation-title"
    onKeyDown={event=>{
      event.stopPropagation();if(guest||event.key!=="Tab")return;
      const nodes=Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')??[]).filter(node=>node.offsetParent!==null);
      const first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }} onKeyUp={event=>event.stopPropagation()}>
    <header className="video-consultation-header"><h2 id="video-consultation-title"><Video size={21}/>휴대폰 영상상담</h2>
      <span role="status">{status}</span>{onClose&&<button type="button" className="icon-button" aria-label="영상상담 닫기" title="닫기" onClick={onClose}><X size={20}/></button>}
    </header>
    <div className="video-consultation-body">
      {!guest&&<div className="video-invitation">
        {!invitation?<button type="button" className="primary-button" disabled={busy||ended} onClick={()=>void begin()}><Video size={18}/>{busy?"준비 중":"영상상담 시작"}</button>:<>
          {invitation.smsRoutingAvailable&&!ended&&<VideoSmsSettings api={api} onChange={(selection,value)=>{smsRouteController.current?.abort();setSmsSelection(selection);setSenderPhone(value);}}/>}
          {invitation.smsRoutingAvailable&&<p role="status">{senderPhone?`등록 발신번호 ${senderPhone.number} · ${videoSmsPhoneStatus(senderPhone)}`:"발송폰 미지정"}</p>}
          {(invitation.smsRoutingAvailable||invitation.smsAvailable!==false)&&<label>휴대폰 번호<input type="tel" inputMode="tel" autoComplete="off" value={phone} maxLength={14} placeholder="010-0000-0000" onChange={event=>setPhone(event.target.value)} disabled={ended||smsState!=="none"}/></label>}
          <div className="button-row">{(invitation.smsRoutingAvailable||invitation.smsAvailable!==false)&&<button type="button" className="primary-button" disabled={busy||ended||smsState!=="none"||(invitation.smsRoutingAvailable&&!senderPhone?.ready)||!/^01[016789]\d{7,8}$/.test(phone.replace(/[ -]/g,""))} onClick={()=>void sendSms()}><Send size={16}/>문자 전송</button>}
            <button type="button" className="secondary-button" disabled={ended} onClick={()=>void navigator.clipboard.writeText(invitation.link).then(()=>setStatus("초대 링크 복사됨"),()=>setError("링크 복사에 실패했습니다. 아래 주소를 선택해 복사해 주세요."))}><Copy size={16}/>링크 복사</button></div>
          <label>초대 링크<input readOnly value={invitation.link} aria-label="영상상담 초대 링크" onFocus={event=>event.target.select()}/></label>
          <small>초대 유효시간 {new Date(invitation.inviteExpiresAt).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}까지</small>
          {smsState!=="none"&&<p role="status">{smsState==="accepted"?"문자 발송업체 접수 완료 · 휴대폰 수신 완료와는 다릅니다.":smsState==="sending"?"문자 접수 확인 중":"문자 접수 결과 미확인 · 중복 재전송하지 않습니다."}</p>}
        </>}
      </div>}
      <div className="video-consultation-stage">
        <video ref={guest?localVideo:remoteVideo} autoPlay playsInline muted aria-label={guest?"내 카메라":"고객 카메라"} onLoadedData={()=>setHasPicture(true)}/>
        {(guest?!local.current:!hasPicture)&&<div className="video-consultation-placeholder"><Video size={44}/><span>{guest?"WonRemote 영상상담":"고객 카메라 연결 대기"}</span></div>}
        {guest&&!local.current&&!ended&&<div className="video-customer-start"><p>시작하면 카메라 권한을 요청합니다. 상담원에게 카메라 영상이 전달되며 마이크는 사용하지 않습니다.</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void begin()}><Video size={18}/>{busy?"준비 중":"카메라 허용하고 시작"}</button></div>}
      </div>
    </div>
    {error&&<p className="video-consultation-error" role="alert">{error}</p>}
    <footer className="video-consultation-footer">
      <span>{ended?"상담 종료":guest&&local.current?"카메라 송출 중":"영상상담"}</span>
      {!guest&&ended&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>{roomId.current="";admitted.current=false;setInvitation(null);setEnded(false);setError("");setSmsState("none");setHasPicture(false);setStatus("새 상담");}}>새 상담</button>}
      {playBlocked&&<button type="button" className="secondary-button" onClick={()=>play(guest?localVideo.current:remoteVideo.current)}><Video size={18}/>영상 재생</button>}
      {guest&&<button type="button" className="secondary-button" disabled={busy||ended||!peer.current} aria-label="카메라 전환" title="전면·후면 카메라 전환" onClick={()=>void switchCamera()}><SwitchCamera size={19}/></button>}
      {guest&&<button type="button" className="secondary-button" disabled={busy||ended||!peer.current||!torchAvailable} aria-label={torch?"후레쉬 끄기":"후레쉬 켜기"} aria-pressed={torch} title={torchAvailable?(torch?"후레쉬 끄기":"후레쉬 켜기"):"현재 카메라 또는 브라우저는 후레쉬를 지원하지 않습니다"} onClick={()=>void toggleTorch()}>{torch?<FlashlightOff size={19}/>:<Flashlight size={19}/>}</button>}
      <button type="button" className="danger-button" disabled={ended||(!roomId.current&&!guest)} onClick={()=>void end()}><PhoneOff size={18}/>상담 종료</button>
    </footer>
  </section>;
}

export function VideoConsultationGuest(){
  const [invite]=useState(()=>readVideoInvite(location.hash));
  return <main className="video-consultation-page">{invite?<VideoConsultation guest={invite}/>:<section className="video-invalid-link"><Video size={40}/><h1>영상상담 초대 링크를 확인해 주세요</h1><p>상담원에게 새 링크를 요청해 주세요.</p></section>}</main>;
}
