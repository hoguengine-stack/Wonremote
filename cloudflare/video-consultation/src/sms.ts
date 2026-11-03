import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { VideoError, videoHash } from "../../../functions/src/videoConsultationCore";
import { limitedJson } from "./http";

type Storage = {
  get<T>(key:string):Promise<T|undefined>;
  put(key:string,value:unknown):Promise<unknown>;
  delete(key:string):Promise<unknown>;
};
export type SmsPhone = {id:string;name:string;state:"recent"|"offline"|"disabled"|"unknown";lastSeen:number|null;sims:{id:number;ready:boolean}[]};
type Profile = {deviceId:string;simId:number;number:string;sealed:string};
export const smsActions = ["sms-route","sms-phones","sms-save","sms-remove"];
export function smsProfileKey(owner:string,input:Record<string,unknown>){
  if(input.smsMode==="counselor")return `smsPhoneProfiles/counselor/${videoHash(owner)}`;
  if(input.smsMode!=="pc"||typeof input.smsPcKey!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(input.smsPcKey))throw new VideoError(400,"발송 방식과 이 PC 등록 정보를 확인해 주세요.");
  // Possession of this random PC capability deliberately shares its phone across signed-in counselors on that PC.
  return `smsPhoneProfiles/pc/${videoHash(input.smsPcKey)}`;
}
function providerKey(value:unknown){
  if(typeof value!=="string"||value.length<16||value.length>256||!/^[\x21-\x7e]+$/.test(value))throw new VideoError(400,"Textbee API 키를 확인해 주세요.");
  return value;
}
function encryptionKey(secret:string){
  if(secret.length<32)throw new VideoError(412,"문자 보안 설정이 준비되지 않았습니다.");
  return Buffer.from(hkdfSync("sha256",secret,"wonremote-video-sms-v1","phone-credentials",32));
}
export function sealSmsKey(value:string,secret:string,scope:string){
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",encryptionKey(secret),iv);
  cipher.setAAD(Buffer.from(scope));
  const data=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString("base64url");
}
function openSmsKey(value:string,secret:string,scope:string){
  try{
    const data=Buffer.from(value,"base64url"),cipher=createDecipheriv("aes-256-gcm",encryptionKey(secret),data.subarray(0,12));
    cipher.setAAD(Buffer.from(scope));cipher.setAuthTag(data.subarray(12,28));
    return providerKey(Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString("utf8"));
  }catch{throw new VideoError(412,"발송폰 보안 정보를 다시 등록해 주세요.");}
}
function phone(value:any,now:number):SmsPhone{
  if(!value||typeof value._id!=="string"||!/^[a-f0-9]{24}$/i.test(value._id))throw new VideoError(503,"발송폰 정보를 확인하지 못했습니다.");
  const lastSeen=typeof value.lastHeartbeat==="string"?Date.parse(value.lastHeartbeat):NaN;
  const minutes=Number.isFinite(value.heartbeatIntervalMinutes)?Math.max(1,Math.min(30,value.heartbeatIntervalMinutes)):30;
  const recent=Number.isFinite(lastSeen)&&lastSeen<=now&&now-lastSeen<=minutes*120_000;
  const sims=(Array.isArray(value.simInfo?.sims)?value.simInfo.sims:[]).slice(0,4)
    .filter((s:any)=>Number.isInteger(s.subscriptionId)&&s.subscriptionId>=0)
    .map((s:any)=>({id:s.subscriptionId,ready:s.serviceState==="IN_SERVICE"}));
  return {id:value._id,name:typeof value.name==="string"?value.name.slice(0,80):"Android 발송폰",
    state:value.enabled!==true?"disabled":!Number.isFinite(lastSeen)?"unknown":!recent||value.networkInfo?.networkType==="none"?"offline":"recent",
    lastSeen:Number.isFinite(lastSeen)?lastSeen:null,sims};
}
export function createSmsGateway(storage:Storage,secret:string,send:typeof fetch=fetch,now=Date.now){
  async function request(key:string,path:string,body?:unknown){
    let response:Response;
    try{response=await send(`https://api.textbee.dev/api/v1/gateway/${path}`,{method:body?"POST":"GET",headers:{"x-api-key":key,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:"manual",signal:AbortSignal.timeout(8_000)});}
    catch{throw new VideoError(503,"문자 서비스 응답을 확인하지 못했습니다.");}
    if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw new VideoError(response.status===429?429:502,response.status===429?"문자 서비스 사용 한도에 도달했습니다.":response.status===401?"Textbee API 키가 만료되었거나 올바르지 않습니다.":"문자 서비스가 요청을 거부했습니다.");}
    try{return await limitedJson(response.body,100_000) as any;}catch{throw new VideoError(503,"문자 서비스 응답이 올바르지 않습니다.");}
  }
  async function getPhone(key:string,id:string){
    if(!/^[a-f0-9]{24}$/i.test(id))throw new VideoError(400,"지정 발송폰을 확인해 주세요.");
    const result=phone((await request(key,`devices/${id}`)).data,now());
    if(result.id!==id)throw new VideoError(503,"지정한 발송폰의 응답이 아닙니다.");
    return result;
  }
  function visible(profile:Profile,current:SmsPhone){
    const sim=current.sims.find(s=>s.id===profile.simId);
    return {deviceId:profile.deviceId,name:current.name,number:profile.number,simId:profile.simId,
      state:current.state,lastSeen:current.lastSeen,ready:current.state==="recent"&&sim?.ready===true};
  }
  async function execute(owner:string,input:Record<string,unknown>){
    const scope=smsProfileKey(owner,input),action=input.action;
    if(action==="sms-phones"){
      const data=(await request(providerKey(input.apiKey),"devices")).data;
      if(!Array.isArray(data)||data.length>50)throw new VideoError(503,"발송폰 목록이 올바르지 않습니다.");
      return {phones:data.map(v=>phone(v,now()))};
    }
    if(action==="sms-remove"){await storage.delete(scope);return {phone:null};}
    if(action==="sms-save"){
      const key=providerKey(input.apiKey),id=String(input.deviceId??""),simId=input.simId;
      const number=typeof input.number==="string"?input.number.replace(/[ -]/g,""):"";
      if(!/^01[016789]\d{7,8}$/.test(number)||!Number.isInteger(simId)||Number(simId)<0)throw new VideoError(400,"발신번호와 SIM을 확인해 주세요.");
      const current=await getPhone(key,id);
      if(!current.sims.some(s=>s.id===simId))throw new VideoError(400,"선택한 SIM이 이 휴대폰에 없습니다.");
      const profile:Profile={deviceId:id,simId:Number(simId),number,sealed:sealSmsKey(key,secret,scope)};
      await storage.put(scope,profile);return {phone:visible(profile,current)};
    }
    if(action!=="sms-route")throw new VideoError(400,"지원하지 않는 발송폰 설정입니다.");
    const profile=await storage.get<Profile>(scope);
    if(!profile)return {phone:null};
    const key=openSmsKey(profile.sealed,secret,scope);
    return {phone:visible(profile,await getPhone(key,profile.deviceId))};
  }
  async function prepare(owner:string,input:Record<string,unknown>){
    const scope=smsProfileKey(owner,input),profile=await storage.get<Profile>(scope);
    if(!profile)throw new VideoError(412,"선택한 방식의 발송폰을 먼저 등록해 주세요.");
    const key=openSmsKey(profile.sealed,secret,scope),current=await getPhone(key,profile.deviceId);
    if(!visible(profile,current).ready)throw new VideoError(412,"지정폰의 최근 응답·네트워크·SIM을 확인해 주세요. 다른 폰으로 발송하지 않습니다.");
    return async(to:string,link:string)=>{
      const response=await request(key,"send-sms",{recipients:[`+82${to.slice(1)}`],message:`WonRemote: ${link}`,deviceId:profile.deviceId,simSubscriptionId:profile.simId});
      if(response.data?.success!==true||typeof response.data?.smsBatchId!=="string")throw new VideoError(503,"문자 접수 결과를 확인하지 못했습니다.");
    };
  }
  return {execute,prepare};
}
