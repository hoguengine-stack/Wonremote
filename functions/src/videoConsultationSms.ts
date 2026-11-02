import { createHmac, randomBytes } from "node:crypto";

export function solapiVideoSms(config:{apiKey:string;apiSecret:string;from:string},send:typeof fetch=fetch){
  if(!config.apiKey||!config.apiSecret||!/^\d{8,12}$/.test(config.from))throw new Error("Invalid SMS server configuration");
  return async(to:string,link:string)=>{
    const date=new Date().toISOString(),salt=randomBytes(16).toString("hex");
    const signature=createHmac("sha256",config.apiSecret).update(date+salt).digest("hex");
    const response=await send("https://api.solapi.com/messages/v4/send-many/detail",{
      method:"POST",signal:AbortSignal.timeout(15_000),redirect:"error",
      headers:{"Content-Type":"application/json",Authorization:`HMAC-SHA256 apiKey=${config.apiKey}, date=${date}, salt=${salt}, signature=${signature}`},
      body:JSON.stringify({messages:[{to,from:config.from,text:`[WonRemote] 휴대폰 영상상담 초대입니다. 링크를 열고 시작을 눌러 주세요.\n${link}`,type:"LMS",subject:"영상상담 초대"}],allowDuplicates:false}),
    });
    if(!response.ok)throw new Error("SMS submission failed");
    const result=await response.json() as {groupInfo?:{count?:{registeredSuccess?:number}};failedMessageList?:unknown[]};
    if(result.failedMessageList?.length||result.groupInfo?.count?.registeredSuccess!==1)throw new Error("SMS submission not confirmed");
  };
}
