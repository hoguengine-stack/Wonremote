import { mkdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSmsGateway } from "../../cloudflare/video-consultation/src/sms";

let browser:Browser,bundle:string;
const key="fixture-textbee-secret-1234",first="664a9b8cd0e1f2a3b4c5d6e7",second="664a9b8cd0e1f2a3b4c5d6e8";
beforeAll(async()=>{
  bundle=(await build({stdin:{resolveDir:process.cwd(),loader:"tsx",contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{VideoConsultation}from'./src/components/VideoConsultation';
    const w=window;w.calls=[];w.api={call:async(action,roomId,data,signal)=>{
      w.calls.push(action);const result=await w.serverCall({action,roomId,...data});
      if(w.delayRoute&&action==='sms-route')await new Promise(r=>w.releaseRoute=r);
      if(signal?.aborted)throw new DOMException('cancelled','AbortError');return result;
    },watch:(id,next,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))};
    w.mount=()=>{w.root=createRoot(document.getElementById('root'));w.root.render(<React.StrictMode><VideoConsultation api={w.api} onClose={()=>w.root.unmount()}/></React.StrictMode>);};
  `},bundle:true,write:false,format:"iife",platform:"browser",define:{"import.meta.env":"{}","process.env.NODE_ENV":'"development"'}})).outputFiles[0].text;
  browser=await chromium.launch({headless:true});mkdirSync("../.codex-tmp/video-sms",{recursive:true});
},30_000);
afterAll(async()=>{await browser?.close();});
function backend(){
  const docs=new Map<string,any>(),sends:any[]=[];let offline=false;
  const device=(id:string)=>({_id:id,name:id===first?"사무실 공용폰":"상담사 전용폰",enabled:true,lastHeartbeat:new Date(Date.now()-(offline?7_200_000:0)).toISOString(),simInfo:{sims:[{subscriptionId:7,serviceState:"IN_SERVICE"}]}});
  const provider=async(url:any,options?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/send-sms')){sends.push(JSON.parse(options!.body as string));return Response.json({data:{success:true,smsBatchId:"queued-fixture"}});}
    return Response.json({data:path.endsWith('/devices')?[device(first),device(second)]:device(path.split('/').slice(-1)[0])});
  };
  const gateway=createSmsGateway({get:async<T>(id:string)=>docs.get(id) as T|undefined,put:async(id:string,value:unknown)=>{docs.set(id,value);},delete:async(id:string)=>docs.delete(id)},"i".repeat(32),provider as typeof fetch);
  const actions:string[]=[];let user="counselor-a";
  async function open(mobile=false,routeFailure=false){
    const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900}});page.setDefaultTimeout(8_000);
    await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" class="video-consultation-backdrop"></div>'}));
    await page.exposeFunction('serverCall',async(input:Record<string,unknown>)=>{
      actions.push(String(input.action));
      if(input.action==='sms-route'&&routeFailure)throw new Error('지정폰 확인 서버에 연결하지 못했습니다.');
      if(String(input.action).startsWith('sms-'))return gateway.execute(user,input);
      if(input.action==='create')return {roomId:input.roomId,rtc:{iceServers:[]},smsAvailable:false,smsRoutingAvailable:true,link:`http://localhost/video-support#room=${input.roomId}&token=${'t'.repeat(43)}`,inviteExpiresAt:Date.now()+900_000};
      if(input.action==='sms'){await (await gateway.prepare(user,input))(String(input.phone),'http://localhost/video-support#private');return {smsState:'accepted'};}
      return {ok:true};
    });
    await page.goto('http://localhost');await page.addStyleTag({content:readFileSync('src/styles.css','utf8')});await page.addScriptTag({content:bundle});await page.evaluate(()=>(window as any).mount());
    await page.getByRole('textbox',{name:'영상상담 초대 링크'}).waitFor();return page;
  }
  return {open,docs,actions,sends,setUser:(value:string)=>{user=value;},setOffline:()=>{offline=true;}};
}
async function settings(page:Page){await page.getByRole('button',{name:'발송폰 설정',exact:true}).click();await expect.poll(()=>page.getByRole('combobox',{name:'문자 발송 방식'}).isEnabled()).toBe(true);}
async function register(page:Page,id=first,number='01012345678'){
  await page.getByRole('textbox',{name:'Textbee API 키',exact:true}).fill(key);
  await page.getByRole('button',{name:'발송폰 조회',exact:true}).click();
  await page.getByRole('combobox',{name:'발송 휴대폰',exact:true}).selectOption(id);
  await page.getByRole('combobox',{name:'발송 SIM',exact:true}).selectOption('7');
  await page.getByRole('textbox',{name:'등록 발신번호',exact:true}).fill(number);
  await page.getByRole('button',{name:'발송폰 연결',exact:true}).click();
  await expect.poll(()=>page.getByRole('textbox',{name:'Textbee API 키',exact:true}).inputValue()).toBe('');
}
async function close(page:Page){await page.getByRole('button',{name:'영상상담 닫기',exact:true}).click();await page.close();}
describe('Viewer SMS phone settings actual browser',()=>{
  it('explains an unassigned phone and failed route without enabling a wrong sender',async()=>{
    const f=backend(),page=await f.open();
    await page.getByText('발송폰 설정에서 문자 발송용 휴대폰과 SIM을 먼저 연결해 주세요.',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'휴대폰 번호',exact:true}).fill('01098765432');
    expect(await page.getByRole('button',{name:'문자 전송',exact:true}).isEnabled()).toBe(false);
    await settings(page);await register(page);await page.getByRole('button',{name:'설정 닫기',exact:true}).click();
    expect(await page.getByRole('button',{name:'문자 전송',exact:true}).isEnabled()).toBe(true);
    expect(f.sends).toHaveLength(0);await close(page);
    const failed=await f.open(false,true);
    await failed.getByText('지정폰 확인 서버에 연결하지 못했습니다.',{exact:true}).waitFor();
    expect(await failed.getByRole('button',{name:'문자 전송',exact:true}).isEnabled()).toBe(false);
    expect(f.sends).toHaveLength(0);await close(failed);
  },30000);
  it('persists PC and counselor routes, isolates other PCs/accounts and sends once from the displayed phone',async()=>{
    const f=backend(),a=await f.open();await settings(a);await register(a);
    await a.getByRole('textbox',{name:'휴대폰 번호',exact:true}).fill('01098765432');
    await a.getByRole('button',{name:'설정 닫기',exact:true}).click();
    await a.getByRole('button',{name:'문자 전송',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    await expect.poll(()=>f.sends.length).toBe(1);expect(f.sends[0]).toMatchObject({deviceId:first,simSubscriptionId:7});
    await a.getByText('문자 발송업체 접수 완료 · 휴대폰 수신 완료와는 다릅니다.',{exact:true}).waitFor();
    expect(await a.evaluate(()=>JSON.stringify(localStorage))).not.toContain(key);
    await settings(a);await a.getByRole('combobox',{name:'문자 발송 방식'}).selectOption('counselor');await register(a,second,'01022223333');
    await a.screenshot({path:'../.codex-tmp/video-sms/settings-desktop.png'});
    const b=await f.open();await settings(b);await b.getByRole('combobox',{name:'문자 발송 방식'}).selectOption('counselor');
    await b.getByText(/상담사 전용폰 · 등록번호 01022223333/).waitFor();
    await b.getByRole('combobox',{name:'문자 발송 방식'}).selectOption('pc');await b.getByText('등록된 발송폰 없음',{exact:true}).waitFor();
    f.setUser('counselor-b');await a.getByRole('combobox',{name:'문자 발송 방식'}).selectOption('pc');await a.getByText(/사무실 공용폰 · 등록번호 01012345678/).waitFor();
    await a.getByRole('combobox',{name:'문자 발송 방식'}).selectOption('counselor');await a.getByText('등록된 발송폰 없음',{exact:true}).waitFor();
    expect(JSON.stringify([...f.docs])).not.toContain(key);await close(a);await close(b);
  },30_000);
  it('renders narrow settings without overflow, blocks stale phones and ignores a late response after closing',async()=>{
    const f=backend(),page=await f.open(true);expect(f.actions.filter(v=>v==='sms-route')).toHaveLength(1);
    await settings(page);await register(page);await page.screenshot({path:'../.codex-tmp/video-sms/settings-mobile.png'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const box=await page.locator('.video-consultation').boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(845);
    const body=await page.locator('.video-consultation-body').boundingBox(),footer=await page.locator('.video-consultation-footer').boundingBox();
    expect(body!.y+body!.height).toBeLessThanOrEqual(footer!.y+1);
    f.setOffline();await page.getByRole('button',{name:'발송폰 상태 새로고침'}).click();await page.getByText(/사무실 공용폰.*응답 오래됨/).waitFor();
    expect(await page.getByRole('button',{name:'문자 전송',exact:true}).isDisabled()).toBe(true);expect(f.sends).toHaveLength(0);
    await page.getByRole('button',{name:'설정 닫기',exact:true}).click();await page.evaluate(()=>(window as any).delayRoute=true);
    await page.getByRole('button',{name:'발송폰 설정',exact:true}).click();await page.waitForFunction(()=>typeof (window as any).releaseRoute==='function');
    await page.getByRole('button',{name:'설정 닫기',exact:true}).click();await page.evaluate(()=>(window as any).releaseRoute());
    expect(await page.getByRole('combobox',{name:'문자 발송 방식'}).count()).toBe(0);expect(await page.locator('input[type=password]').count()).toBe(0);
    await close(page);
  },30_000);
});
