export type VideoSmsSelection = {smsMode:"pc"|"counselor";smsPcKey:string};
export type VideoSmsPhone = {deviceId:string;name:string;number:string;simId:number;state:"recent"|"offline"|"disabled"|"unknown";lastSeen:number|null;ready:boolean};
const storageKey="wonremote-video-sms-pc-v1";
export function readVideoSmsSelection(storage:Storage=localStorage):VideoSmsSelection{
  const raw=storage.getItem(storageKey);
  if(raw){
    const value=JSON.parse(raw);
    if(!["pc","counselor"].includes(value.smsMode)||typeof value.smsPcKey!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(value.smsPcKey))throw new Error("이 PC의 발송폰 설정을 읽지 못했습니다.");
    return {smsMode:value.smsMode,smsPcKey:value.smsPcKey};
  }
  const key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const value:VideoSmsSelection={smsMode:"pc",smsPcKey:key};
  storage.setItem(storageKey,JSON.stringify(value));return value;
}
export function saveVideoSmsSelection(value:VideoSmsSelection,storage:Storage=localStorage){storage.setItem(storageKey,JSON.stringify(value));}
export function videoSmsPhoneStatus(phone:VideoSmsPhone){
  return phone.state==="recent"?(phone.ready?"최근 응답 확인":"SIM 확인 필요"):phone.state==="disabled"?"발송 중지":phone.state==="offline"?"응답 오래됨 / 연결 확인 필요":"연결 확인 불가";
}
