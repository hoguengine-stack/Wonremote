import { VideoError } from "../../../functions/src/videoConsultationCore";

export async function limitedJson(body:ReadableStream<Uint8Array>|null,limit:number):Promise<unknown>{
  if(!body)throw new VideoError(400,"요청 내용이 없습니다.");
  const reader=body.getReader(),decoder=new TextDecoder();let size=0,text="";
  try{
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>limit)throw new VideoError(413,"요청 크기를 초과했습니다.");text+=decoder.decode(chunk.value,{stream:true});}
    try{return JSON.parse(text+decoder.decode());}catch{throw new VideoError(400,"요청 형식이 올바르지 않습니다.");}
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

export function videoFailure(error:unknown){
  return Response.json({error:error instanceof VideoError?error.message:"영상상담 서버를 처리하지 못했습니다."},{status:error instanceof VideoError?error.status:503,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
