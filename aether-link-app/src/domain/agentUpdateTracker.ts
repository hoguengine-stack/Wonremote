import type {ManagedDevice} from "./types";
import {isHigherVersion} from "./versioning";

export interface AgentUpdateNotice {message:string; active:boolean; failed?:boolean}
export function trackAgentUpdate(input:{
  device:ManagedDevice; requestId:string;
  watch:(next:(device:ManagedDevice)=>void,fail:(error:Error)=>void)=>()=>void;
  send:()=>Promise<void>; report:(notice:AgentUpdateNotice)=>void;
  onDevice:(device:ManagedDevice)=>void;
}):()=>void {
  let closed=false, acknowledged=false, sent=false, latest:ManagedDevice|undefined;
  let firstSnapshot=true,baselineVersion=input.device.version??input.device.updateCurrentVersion;
  let stop=()=>{};
  let deadline:ReturnType<typeof setTimeout>;
  const finish=(message:string,failed=false)=>{
    if(closed)return;
    closed=true;clearTimeout(deadline);stop();input.report({message,active:false,failed});
  };
  const cancel=()=>{closed=true;clearTimeout(deadline);stop();};
  deadline=setTimeout(()=>finish("Agent 응답이 없습니다. 장비 연결 상태 또는 Agent 업데이트 지원 여부를 확인해 주세요.",true),30_000);
  function next(device:ManagedDevice){
    if(closed||device.id!==input.device.id)return;
    latest=device;if(!sent)return;
    const correlated=device.updateRequestId===input.requestId;
    const current=device.version??device.updateCurrentVersion;
    if(firstSnapshot){firstSnapshot=false;if(!correlated&&current)baselineVersion=current;}
    const newer=Boolean(current&&baselineVersion&&isHigherVersion(current,baselineVersion));
    if(!correlated&&!newer&&!acknowledged)return;
    // A restart may clear the request ID; only a newer running version can complete it.
    if(!correlated&&!newer)return;
    if(!acknowledged){acknowledged=true;clearTimeout(deadline);deadline=setTimeout(()=>finish("업데이트 결과 확인 시간이 초과되었습니다. 완료로 처리하지 않았습니다.",true),600_000);}
    input.onDevice(device);
    const version=current?` v${current}`:"";
    if(device.updateState==="failed"||device.updateState==="rollback") {finish(device.updateError|| (device.updateState==="rollback"?"업데이트 실패 · 이전 버전으로 복구됨":"업데이트 실패"),true);return;}
    if(device.updateState==="healthy") {
      if(newer){finish(`업데이트 완료${version} · Agent 재실행 확인`);return;}
      if(correlated){finish(`최신 버전입니다${version}`);return;}
    }
    if(device.updateState==="idle"){
      input.report({message:device.updateError||(device.updateTargetVersion?`v${device.updateTargetVersion} · 배포 정책에 따라 대기 중`:"업데이트 대기 중"),active:true});return;
    }
    const labels={checking:"업데이트 확인 중",downloading:"다운로드 중",installing:"업데이트 적용 중",restarting:"Agent 재실행 확인 중"};
    const label=labels[device.updateState as keyof typeof labels];
    if(label)input.report({message:`${label}${device.updateState==="downloading"&&typeof device.updateProgress==="number"?` ${device.updateProgress}%`:""}`,active:true});
  }
  input.report({message:"Agent 응답 대기 중",active:true});
  try {
    const unsubscribe=input.watch(next,error=>finish(error.message,true));
    stop=unsubscribe;if(closed)stop();
    if(!closed)void input.send().then(()=>{sent=true;if(latest)next(latest);},error=>finish(error instanceof Error?error.message:"업데이트 요청 실패",true));
  } catch(error){finish(error instanceof Error?error.message:"업데이트 상태 확인 실패",true);}
  return cancel;
}
