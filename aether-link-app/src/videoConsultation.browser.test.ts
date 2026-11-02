import { readFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVideoService, publicVideoRoom, type VideoRoom, type VideoStore } from "../../functions/src/videoConsultationCore";

let browser:Browser,bundle:string;
const evidence="../analysis/2026-11-02-video-consultation";
beforeAll(async()=>{
  const result=await build({stdin:{resolveDir:process.cwd(),loader:"tsx",contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {VideoConsultation} from './src/components/VideoConsultation';
    const w=window;w.tracks=[];w.mediaCalls=0;const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async c=>{w.mediaCalls++;if(w.deny)throw new DOMException('denied','NotAllowedError');if(w.fakeCameraSwitch&&typeof c.video==='object')c={...c,video:{...c.video,facingMode:undefined}};const s=await gum(c);w.tracks.push(...s.getTracks());if(w.delayMedia)await new Promise(r=>w.finishMedia=r);return s;};
    const api={call:(action,roomId,data)=>w.serverCall({action,roomId,...data}),watch:(roomId,next,signal)=>new Promise((resolve,reject)=>{
      w.nextSignal=next;w.serverWatch(roomId).catch(reject);signal.addEventListener('abort',()=>{w.serverStop();resolve();},{once:true});
    })};
    w.root=createRoot(document.getElementById('root'));w.mount=guest=>w.root.render(<React.StrictMode><VideoConsultation guest={guest} api={api} onClose={guest?undefined:()=>w.root.unmount()}/></React.StrictMode>);
  `},bundle:true,write:false,format:"iife",platform:"browser",define:{"import.meta.env":"{}","process.env.NODE_ENV":'"development"'}});
  bundle=result.outputFiles[0].text;
  browser=await chromium.launch({headless:true,args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
  mkdirSync(evidence,{recursive:true});
},30_000);
afterAll(async()=>{await browser?.close();});

function fixture(){
  const docs=new Map<string,Record<string,unknown>>(),watchers=new Set<{page:Page;id:string}>();let tail=Promise.resolve();
  const actions:string[]=[];
  const store:VideoStore={
    transact(action){
      const run=tail.then(async()=>{
        const writes=new Map<string,Record<string,unknown>>();
        const result=await action({get:async path=>structuredClone(docs.get(path)),put:(path,value)=>writes.set(path,structuredClone(value))});
        for(const [path,value] of writes){docs.set(path,value);if(path.startsWith("videoConsultations/"))for(const w of watchers)if(path.endsWith(w.id))void emit(w.page,value as VideoRoom);}
        return result;
      });tail=run.then(()=>undefined,()=>undefined);return run;
    },watch:()=>()=>{},
  };
  async function emit(page:Page,room:VideoRoom){await page.evaluate(value=>(window as any).nextSignal?.(value),publicVideoRoom(room)).catch(()=>undefined);}
  const service=createVideoService(store,{origin:"http://localhost",inviteSecret:"a".repeat(32),rtc:()=>({iceServers:[]})});
  async function open(guest?:{roomId:string;token:string},options:{mobile?:boolean;deny?:boolean;delay?:boolean}={}){
    const page=await browser.newPage({viewport:options.mobile?{width:390,height:844}:{width:1440,height:900}});
    page.setDefaultTimeout(8_000);const guestKey="g".repeat(43);
    await page.route("http://localhost/**",route=>route.fulfill({contentType:"text/html",body:`<meta name="viewport" content="width=device-width,initial-scale=1"><div class="${guest?"video-consultation-page":"video-consultation-backdrop"}" id="root"></div>`}));
    await page.exposeFunction("serverCall",async(input:Record<string,unknown>)=>{
      actions.push(`${guest?"guest":"viewer"}:${input.action}`);
      return service.execute(guest?null:"viewer",{...input,...(guest?{token:guest.token,guestKey}:{})});
    });
    await page.exposeFunction("serverWatch",async(id:string)=>{
      watchers.add({page,id});const room=docs.get(`videoConsultations/${id}`);if(room)await emit(page,room as VideoRoom);
    });
    await page.exposeFunction("serverStop",()=>{for(const w of watchers)if(w.page===page)watchers.delete(w);});
    await page.goto("http://localhost/video-support");await page.addStyleTag({content:readFileSync("src/styles.css","utf8")});
    await page.evaluate(options=>{Object.assign(window,{deny:options.deny,delayMedia:options.delay});},options);
    await page.addScriptTag({content:bundle});await page.evaluate(guest=>(window as any).mount(guest),guest);
    return page;
  }
  return {open,actions,watchers,docs};
}
async function until(check:()=>Promise<boolean>){for(let i=0;i<120;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error("Browser condition not reached");}
async function noOverflow(page:Page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const bounds=await page.locator(".video-consultation").evaluate(node=>({bottom:node.getBoundingClientRect().bottom,height:innerHeight}));
    expect(bounds.bottom,JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.height+1);
}

describe("video consultation actual browser media",()=>{
  it("requires consent, renders moving video and audio tracks, handles missing SMS provider and closes every track",async()=>{
    const f=fixture(),owner=await f.open();await owner.getByRole("button",{name:"영상상담 시작",exact:true}).click();
    const link=await owner.getByRole("textbox",{name:"영상상담 초대 링크"}).inputValue();const params=new URL(link).hash;const query=new URLSearchParams(params.slice(1));
    await owner.context().grantPermissions(["clipboard-read","clipboard-write"],{origin:"http://localhost"});
    await owner.getByRole("button",{name:"링크 복사",exact:true}).click();expect(await owner.evaluate(()=>navigator.clipboard.readText())).toBe(link);
    await owner.getByRole("textbox",{name:"휴대폰 번호",exact:true}).fill("01012345678");await owner.getByRole("button",{name:"문자 전송",exact:true}).click();
    await owner.getByRole("alert").filter({hasText:"링크 복사"}).waitFor();
    const guest=await f.open({roomId:query.get("room")!,token:query.get("token")!},{mobile:true});
    expect(await guest.evaluate(()=>(window as any).mediaCalls)).toBe(0);expect(f.actions.filter(a=>a==="guest:end")).toHaveLength(0);
    await noOverflow(owner);await noOverflow(guest);await guest.screenshot({path:`${evidence}/phone-consent.png`});
    await guest.getByRole("button",{name:"카메라·마이크 허용하고 시작",exact:true}).click();
    await until(()=>owner.locator("video").evaluate(node=>{const video=node as HTMLVideoElement;return video.readyState>=2&&video.videoWidth>0;}));
    const measure=()=>owner.locator("video").evaluate(node=>{
      const video=node as HTMLVideoElement;
      const c=document.createElement("canvas");c.width=64;c.height=36;const ctx=c.getContext("2d")!;ctx.drawImage(video,0,0,64,36);const pixels=ctx.getImageData(0,0,64,36).data;
      return {width:video.videoWidth,height:video.videoHeight,colors:new Set(Array.from(pixels)).size,frame:video.getVideoPlaybackQuality().totalVideoFrames,audio:(video.srcObject as MediaStream).getAudioTracks().length};
    });
    const first=await measure();expect(first.colors).toBeGreaterThan(20);expect(first.audio).toBe(1);
    await until(async()=>(await measure()).frame>first.frame+2);
    await owner.getByRole("button",{name:"마이크 켜기",exact:true}).click();
    await until(()=>guest.locator("audio").evaluate(node=>((node as HTMLAudioElement).srcObject as MediaStream|null)?.getAudioTracks().length===1));
    await guest.getByRole("button",{name:"마이크 끄기",exact:true}).click();expect(await guest.evaluate(()=>(window as any).tracks.find((t:MediaStreamTrack)=>t.kind==="audio").enabled)).toBe(false);
    await guest.getByRole("button",{name:"마이크 켜기",exact:true}).click();
    await guest.evaluate(()=>(window as any).fakeCameraSwitch=true);await guest.getByRole("button",{name:"카메라 전환",exact:true}).click();
    await until(()=>guest.evaluate(()=>(window as any).tracks.filter((t:MediaStreamTrack)=>t.kind==="video").length===2));
    await until(()=>guest.evaluate(()=>(window as any).tracks.find((t:MediaStreamTrack)=>t.kind==="video").readyState==="ended"));
    await noOverflow(guest);await owner.screenshot({path:`${evidence}/viewer-connected.png`});await guest.screenshot({path:`${evidence}/phone-connected.png`});
    await guest.getByRole("button",{name:"상담 종료",exact:true}).click();
    await until(()=>owner.getByText("상담 종료",{exact:true}).count().then(n=>n>=1));
    for(const p of [owner,guest])expect(await p.evaluate(()=>(window as any).tracks.every((t:MediaStreamTrack)=>t.readyState==="ended"))).toBe(true);
    await until(async()=>f.watchers.size===0);expect(f.actions.filter(a=>a==="viewer:create")).toHaveLength(1);expect(f.actions.filter(a=>a==="viewer:sms")).toHaveLength(1);
    await owner.close();await guest.close();
  },30_000);
  it("permission denial does not claim the invitation, and late permission after close stops camera without joining",async()=>{
    const f=fixture(),owner=await f.open();await owner.getByRole("button",{name:"영상상담 시작",exact:true}).click();
    const link=await owner.getByRole("textbox",{name:"영상상담 초대 링크"}).inputValue(),p=new URLSearchParams(new URL(link).hash.slice(1));
    const invite={roomId:p.get("room")!,token:p.get("token")!};
    const denied=await f.open(invite,{mobile:true,deny:true});
    await denied.getByRole("button",{name:"카메라·마이크 허용하고 시작",exact:true}).click();await denied.getByRole("alert").waitFor();
    expect(f.actions.includes("guest:join")).toBe(false);await denied.close();
    const late=await f.open(invite,{mobile:true,delay:true});await late.getByRole("button",{name:"카메라·마이크 허용하고 시작",exact:true}).click();
    await until(()=>late.evaluate(()=>Boolean((window as any).finishMedia)));await late.evaluate(()=>{(window as any).root.unmount();(window as any).finishMedia();});
    await until(()=>late.evaluate(()=>(window as any).tracks.every((t:MediaStreamTrack)=>t.readyState==="ended")));
    expect(f.actions.includes("guest:join")).toBe(false);await late.close();await owner.evaluate(()=>(window as any).root.unmount());await owner.close();
  },20_000);
  it("keeps consent controls usable on narrow phones and landscape, and traps owner dialog focus",async()=>{
    const f=fixture(),owner=await f.open();await owner.setViewportSize({width:1024,height:768});await noOverflow(owner);
    expect(await owner.getByRole("button",{name:"상담 종료",exact:true}).isDisabled()).toBe(true);
    await owner.getByRole("button",{name:"영상상담 닫기",exact:true}).focus();await owner.keyboard.press("Shift+Tab");
    expect(await owner.getByRole("button",{name:"영상상담 시작",exact:true}).evaluate(node=>node===document.activeElement)).toBe(true);
    await owner.close();
    for(const viewport of [{width:320,height:568},{width:844,height:390}]){
      const guest=await f.open({roomId:"11111111-1111-4111-8111-111111111111",token:"t".repeat(43)},{mobile:true});
      await guest.setViewportSize(viewport);await noOverflow(guest);
      await guest.getByRole("button",{name:"카메라·마이크 허용하고 시작",exact:true}).click({trial:true});
      await guest.close();
    }
  });
  it("expires unused invitations, ends once, and does not restart work after unmount",async()=>{
    const f=fixture(),owner=await f.open();await owner.clock.install();
    await owner.getByRole("button",{name:"영상상담 시작",exact:true}).click();await until(async()=>f.watchers.size===1);
    await owner.clock.fastForward(15*60_000+1000);await owner.getByRole("button",{name:"새 상담",exact:true}).waitFor();
    await owner.getByRole("alert").filter({hasText:"유효시간"}).waitFor();await until(async()=>f.actions.includes("viewer:end"));
    await owner.evaluate(()=>(window as any).root.unmount());await owner.clock.fastForward(60*60_000);
    expect(f.actions.filter(v=>v==="viewer:end")).toHaveLength(1);expect(f.actions.filter(v=>v==="viewer:create")).toHaveLength(1);
    await until(async()=>f.watchers.size===0);await owner.close();
  });
});
