import { RefreshCw, Save, Search, Settings, Unplug, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { VideoApi } from "../api/videoConsultationApi";
import { readVideoSmsSelection, saveVideoSmsSelection, videoSmsPhoneStatus, type VideoSmsPhone, type VideoSmsSelection } from "../domain/videoSms";

type PhoneOption={id:string;name:string;sims:{id:number;ready:boolean}[]};
export function VideoSmsSettings({api,onChange}:{api:VideoApi;onChange:(selection:VideoSmsSelection,phone:VideoSmsPhone|null)=>void}){
  const [open,setOpen]=useState(false),[selection,setSelection]=useState<VideoSmsSelection|null>(null),[phone,setPhone]=useState<VideoSmsPhone|null>(null);
  const [apiKey,setApiKey]=useState(""),[phones,setPhones]=useState<PhoneOption[]>([]),[deviceId,setDeviceId]=useState(""),[simId,setSimId]=useState(""),[number,setNumber]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const active=useRef<AbortController|null>(null),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;active.current?.abort();};},[]);
  async function request(action:string,context:VideoSmsSelection,data:Record<string,unknown>={}){
    if(active.current)return;
    const controller=new AbortController();active.current=controller;setBusy(true);setError("");
    if(action!=="sms-phones"){setPhone(null);onChange(context,null);}
    try{
      const result=await api.call(action,"",{...context,...data},controller.signal);
      if(!live.current||controller.signal.aborted)return;
      if(action==="sms-phones"){setPhones(result.phones);setDeviceId("");setSimId("");}
      else{
        saveVideoSmsSelection(context);setSelection(context);setPhone(result.phone);onChange(context,result.phone);
        if(action==="sms-save"){setApiKey("");setPhones([]);setDeviceId("");setSimId("");setNumber("");}
      }
    }catch(cause){if(live.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:"발송폰 설정을 처리하지 못했습니다.");}
    finally{if(active.current===controller){active.current=null;if(live.current)setBusy(false);}}
  }
  function close(){active.current?.abort();active.current=null;setBusy(false);setOpen(false);setApiKey("");setPhones([]);setDeviceId("");setSimId("");setNumber("");setError("");}
  function show(){
    if(open){close();return;}
    setOpen(true);
    try{const value=readVideoSmsSelection();setSelection(value);void request("sms-route",value);}
    catch{setError("이 PC의 발송폰 설정을 저장하지 못했습니다. 저장소 접근을 확인해 주세요.");}
  }
  return <div className="video-sms-settings">
    <button type="button" className="secondary-button" aria-expanded={open} onClick={show}><Settings size={16}/>발송폰 설정</button>
    {open&&<fieldset disabled={busy}>
      <legend>문자 발송폰</legend>
      <label>발송 방식<select aria-label="문자 발송 방식" value={selection?.smsMode??"pc"} disabled={!selection||busy} onChange={event=>{
        if(!selection)return;const value={...selection,smsMode:event.target.value as VideoSmsSelection["smsMode"]};
        setSelection(value);setPhone(null);onChange(value,null);setApiKey("");setPhones([]);setDeviceId("");setSimId("");setNumber("");void request("sms-route",value);
      }}><option value="pc">이 뷰어 PC 지정폰</option><option value="counselor">로그인 상담사 지정폰</option></select></label>
      <p role="status">{busy?"발송폰 확인 중":phone?`${phone.name} · 등록번호 ${phone.number} · ${videoSmsPhoneStatus(phone)}`:"등록된 발송폰 없음"}</p>
      {phone?.lastSeen&&<small>마지막 응답 {new Date(phone.lastSeen).toLocaleString("ko-KR")}</small>}
      <div className="button-row">
        <button type="button" className="secondary-button icon-button" aria-label="발송폰 상태 새로고침" title="상태 새로고침" disabled={!selection||busy} onClick={()=>selection&&void request("sms-route",selection)}><RefreshCw size={16}/></button>
        {phone&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>selection&&void request("sms-remove",selection)}><Unplug size={16}/>연결 해제</button>}
      </div>
      <a href="https://app.textbee.dev" target="_blank" rel="noopener noreferrer">Textbee 휴대폰 등록</a>
      <label>Textbee API 키<input type="password" autoComplete="new-password" aria-label="Textbee API 키" value={apiKey} maxLength={256} onChange={event=>{setApiKey(event.target.value);setPhones([]);setDeviceId("");setSimId("");}}/></label>
      <button type="button" className="secondary-button" disabled={!selection||apiKey.length<16||busy} onClick={()=>selection&&void request("sms-phones",selection,{apiKey})}><Search size={16}/>발송폰 조회</button>
      {phones.length>0&&<>
        <label>발송 휴대폰<select aria-label="발송 휴대폰" value={deviceId} onChange={event=>{setDeviceId(event.target.value);setSimId("");}}><option value="">휴대폰 선택</option>{phones.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
        <label>발송 SIM<select aria-label="발송 SIM" value={simId} onChange={event=>setSimId(event.target.value)}><option value="">SIM 선택</option>{phones.find(value=>value.id===deviceId)?.sims.map(value=><option key={value.id} value={value.id}>SIM {value.id}{value.ready?"":" · 서비스 확인 필요"}</option>)}</select></label>
        <label>발신번호 (휴대폰에서 확인)<input type="tel" aria-label="등록 발신번호" autoComplete="off" maxLength={14} value={number} onChange={event=>setNumber(event.target.value)}/></label>
        <button type="button" className="primary-button" disabled={!deviceId||simId===""||!/^01[016789]\d{7,8}$/.test(number.replace(/[ -]/g,""))||busy} onClick={()=>selection&&void request("sms-save",selection,{apiKey,deviceId,simId:Number(simId),number})}><Save size={16}/>발송폰 연결</button>
      </>}
    </fieldset>}
    {open&&<button type="button" className="secondary-button" onClick={close}><X size={16}/>설정 닫기</button>}
    {error&&<p role="alert" className="video-sms-error">{error}</p>}
  </div>;
}
