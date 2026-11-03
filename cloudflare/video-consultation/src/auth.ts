import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { VideoError } from "../../../functions/src/videoConsultationCore";
import { limitedJson } from "./http";

const googleKeys=createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),{timeoutDuration:5000,cacheMaxAge:3_600_000});
export type VideoIdentity={uid:string;expiresAt:number};
export async function verifyVideoViewer(raw:string,config:{FIREBASE_PROJECT_ID:string;FIREBASE_WEB_API_KEY:string;BOOTSTRAP_VIEWER_UID:string},send:typeof fetch=fetch,keys:JWTVerifyGetKey=googleKeys):Promise<VideoIdentity>{
  if(!config.FIREBASE_PROJECT_ID||!config.FIREBASE_WEB_API_KEY||!config.BOOTSTRAP_VIEWER_UID)throw new VideoError(412,"영상상담 인증 서버 설정이 필요합니다.");
  if(!raw.startsWith("Bearer ")||raw.length>16_384)throw new VideoError(401,"Viewer 로그인이 필요합니다.");
  const idToken=raw.slice(7);
  let claims;
  try{
    claims=(await jwtVerify(idToken,keys,{algorithms:["RS256"],issuer:`https://securetoken.google.com/${config.FIREBASE_PROJECT_ID}`,audience:config.FIREBASE_PROJECT_ID,requiredClaims:["sub","iat","exp","auth_time"]})).payload;
    const now=Math.floor(Date.now()/1000);
    if(!claims.sub||claims.sub.length>128||typeof claims.iat!=="number"||claims.iat>now||typeof claims.auth_time!=="number"||claims.auth_time>now)throw new Error("Invalid identity");
  }catch{throw new VideoError(401,"Viewer 로그인이 만료되었거나 올바르지 않습니다.");}
  if(claims.sub!==config.BOOTSTRAP_VIEWER_UID&&claims.wonremoteViewer!==true)throw new VideoError(403,"Viewer 계정으로 로그인해 주세요.");
  let response;
  try{
    response=await send(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(config.FIREBASE_WEB_API_KEY)}`,{
      method:"POST",headers:{"Content-Type":"application/json"},redirect:"manual",signal:AbortSignal.timeout(5_000),body:JSON.stringify({idToken}),
    });
  }catch{throw new VideoError(503,"Viewer 계정 상태를 확인하지 못했습니다.");}
  if(!response.ok)throw new VideoError(response.status===400||response.status===401?401:503,"Viewer 계정 상태를 확인하지 못했습니다. 다시 로그인해 주세요.");
  let user;
  try{const body=await limitedJson(response.body,65_536) as {users?:{localId?:string;disabled?:boolean;validSince?:string}[]};if(body.users?.length!==1)throw new Error("Missing user");user=body.users[0];}
  catch{throw new VideoError(503,"Viewer 계정 상태 응답이 올바르지 않습니다.");}
  if(user.localId!==claims.sub||user.disabled||!user.validSince||!/^\d+$/.test(user.validSince)||Number(claims.auth_time)<Number(user.validSince))throw new VideoError(401,"사용 중지되었거나 로그인이 해제된 Viewer 계정입니다.");
  return {uid:claims.sub!,expiresAt:claims.exp!*1000};
}
