import { VideoError } from "../../../functions/src/videoConsultationCore";
import { limitedJson } from "./http";

export async function cloudflareTurn(keyId:string,apiToken:string,send:typeof fetch=fetch){
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(keyId)||!apiToken.trim())throw new VideoError(412,"Cloudflare 영상 중계 설정이 필요합니다.");
  try{
    const response=await send(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,{
      method:"POST",redirect:"manual",signal:AbortSignal.timeout(8_000),
      headers:{Authorization:`Bearer ${apiToken}`,"Content-Type":"application/json"},body:JSON.stringify({ttl:3900}),
    });
    if(!response.ok)throw new Error("TURN request failed");
    const result=await limitedJson(response.body,16_384) as {iceServers?:{urls:unknown;username?:unknown;credential?:unknown}[]};
    if(!Array.isArray(result.iceServers)||result.iceServers.length>8)throw new Error("Invalid TURN response");
    let hasTurn=false;
    const iceServers=result.iceServers.flatMap(server=>{
      const raw=typeof server.urls==="string"?[server.urls]:server.urls;
      if(!Array.isArray(raw)||!raw.length||raw.length>12||raw.some(url=>typeof url!=="string"||!/^(?:stun:stun|turns?:turn)\.cloudflare\.com:(?:3478|443|5349|80|53)(?:\?transport=(?:udp|tcp))?$/.test(url)))throw new Error("Invalid relay URL");
      // Cloudflare may return port53, which browsers block; keep its other relay routes.
      const urls=raw.filter(url=>!/:53(?:\?|$)/.test(url));if(!urls.length)return [];
      const relay=urls.some(url=>/^turns?:/.test(url));hasTurn ||= relay;
      if(!relay)return [{urls}];
      if(typeof server.username!=="string"||!server.username||server.username.length>1024||typeof server.credential!=="string"||!server.credential||server.credential.length>1024||server.credential===apiToken)throw new Error("Invalid relay credential");
      return [{urls,username:server.username,credential:server.credential}];
    });
    if(!hasTurn)throw new Error("Relay missing");
    return {iceServers,iceTransportPolicy:"all" as const};
  }catch{
    throw new VideoError(503,"영상 중계에 연결하지 못했습니다. 잠시 후 새 상담을 시작해 주세요.");
  }
}
