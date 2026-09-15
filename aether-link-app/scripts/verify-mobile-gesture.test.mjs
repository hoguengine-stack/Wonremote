import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const bundle = await build({stdin: {resolveDir: process.cwd(), loader:'tsx', contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MobileRemoteGesturePad} from './src/components/MobileRemoteGesturePad';
window.gestures=[]; window.remoteInputs=0; window.padEvents=[];
function App() {
 const landscape=new URLSearchParams(location.search).has('landscape');
 const canvas=React.useRef(null), viewport=React.useRef(null);
 const [touchpad,setTouchpad]=React.useState(false);
 const [view,setView]=React.useState({x:0,y:0,zoom:landscape ? .5 : 1});
 React.useLayoutEffect(()=>{
   const ctx=canvas.current.getContext('2d');
   ctx.fillStyle='#e5edf3';ctx.fillRect(0,0,1920,1080);
   ctx.fillStyle='#176d62';ctx.fillRect(0,0,1920,120);
   ctx.fillStyle='#14212b';ctx.font='80px sans-serif';ctx.fillText('Remote desktop test',100,420);
 },[]);
 return <div onPointerDown={()=>window.remoteInputs++}>
 <div ref={viewport} className={'remote-preview mobile-width-fit-preview'+(landscape?'':' portrait-remote-preview')} style={{height:landscape?300:600,width:landscape?800:360}}>
 <canvas className="remote-canvas" ref={canvas} width={1920} height={1080} style={{transformOrigin:landscape?'center center':'center top',transform:'translate('+view.x+'px,'+view.y+'px) scale('+view.zoom+')'}}/>
 <MobileRemoteGesturePad canvas={canvas} viewport={viewport} revision={JSON.stringify(view)}
 pointer={{dx:16384,dy:32768}} portrait={!landscape}
 touchpad={touchpad?{move:(x,y)=>window.padEvents.push(['move',x,y]),button:down=>window.padEvents.push([down?'down':'up']),scroll:d=>window.padEvents.push(['scroll',d])}:undefined}
 onGesture={(x,y,f)=>{window.gestures.push({x,y,f});setView(v=>({x:v.x+x,y:v.y+y,zoom:v.zoom*f}));}}/>
 </div><button id="toolbar" style={{height:44,width:44}} onClick={()=>setTouchpad(v=>!v)}>Mode</button></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`}, bundle:true, write:false, jsx:'automatic'});
const css=readFileSync('src/styles.css','utf8');
const server=createServer((req,res)=>{
 res.setHeader('content-type', req.url==='/app.js'?'text/javascript':'text/html; charset=utf-8');
 res.end(req.url==='/app.js'?bundle.outputFiles[0].text:`<style>${css}</style><div id="root"></div><script src="/app.js"></script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:840,height:800}});
 const base='http://127.0.0.1:'+server.address().port;
 for (const mode of ['portrait','landscape']) {
   await page.goto(base+(mode==='landscape'?'?landscape=1':''));
   const pad=page.locator('.mobile-gesture-pad'); await pad.waitFor();
   await page.waitForFunction(()=>parseFloat(document.querySelector('.mobile-remote-pointer').style.left)>10);
   const image=await page.locator('canvas').boundingBox(), area=await page.locator('.remote-preview').boundingBox();
   if(mode==='portrait') { assert.equal(image.y,area.y); assert.equal(image.width,area.width); }
   assert.equal(image.height,image.width*1080/1920);
   const cursor=await page.getByLabel('원격 포인터').boundingBox();
   assert.ok(Math.abs((cursor.x+3)-(image.x+image.width*16384/65535))<1);
   assert.ok(Math.abs((cursor.y+3)-(image.y+image.height*32768/65535))<1);
   const margins=await page.locator('.mobile-gesture-region').evaluateAll(nodes=>nodes.map(node=>{
     const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
   }).filter(r=>r.width>2&&r.height>2));
   assert.ok(margins.length>=1);
   if(mode==='landscape') assert.equal(margins.length,4);
   const region=margins.sort((a,b)=>b.width*b.height-a.width*a.height)[0];
   const before=await page.locator('#toolbar').boundingBox();
   await page.mouse.move(region.x+region.width/2,region.y+region.height/2); await page.mouse.down();
   await page.mouse.move(region.x+region.width/2-30,region.y+region.height/2-20); await page.mouse.up();
   assert.equal(await page.evaluate(()=>window.remoteInputs),0);
   assert.notDeepEqual(await page.locator('canvas').boundingBox(),image);
   // Synthetic multi-pointer sequence exercises the component without browser page zoom.
   const prePinchWidth=await page.locator('canvas').evaluate(el=>el.getBoundingClientRect().width);
   await pad.evaluate(el=>{
     el.setPointerCapture=()=>{}; el.hasPointerCapture=()=>false;
     for(const [type,id,x,y] of [['pointerdown',11,100,250],['pointerdown',12,200,250],['pointermove',12,260,250],['pointercancel',11,100,250]])
       el.dispatchEvent(new PointerEvent(type,{pointerId:id,clientX:x,clientY:y,bubbles:true,pointerType:'touch'}));
   });
   await page.waitForFunction(previous=>document.querySelector('canvas').getBoundingClientRect().width>previous*1.1,prePinchWidth);
   const width=await page.locator('canvas').evaluate(el=>el.getBoundingClientRect().width);
   await pad.dispatchEvent('pointermove',{pointerId:12,clientX:300,clientY:250});
   assert.equal(await page.locator('canvas').evaluate(el=>el.getBoundingClientRect().width),width);
   const after=await page.locator('#toolbar').boundingBox();
   assert.equal(before.width,after.width); assert.equal(before.height,after.height);
   assert.equal(await page.evaluate(()=>window.remoteInputs),0);
   await page.screenshot({path:`../.codex-tmp/mobile-gesture-${mode}.png`});
   await page.locator('#toolbar').click();
   const surface=page.getByLabel('원격 터치패드'); await surface.waitFor();
   await surface.evaluate(el=>{
     el.setPointerCapture=()=>{}; el.hasPointerCapture=()=>false;
     const emit=(type,id,x,y)=>el.dispatchEvent(new PointerEvent(type,{pointerId:id,clientX:x,clientY:y,bubbles:true,pointerType:'touch'}));
     emit('pointerdown',1,100,100); emit('pointermove',1,120,110); emit('pointerup',1,120,110);
     emit('pointerdown',1,100,100); emit('pointerup',1,100,100);
     emit('pointerdown',1,100,100); emit('pointermove',1,110,110); emit('pointerup',1,110,110);
   });
   assert.deepEqual(await page.evaluate(()=>window.padEvents), [['move',20,10],['down'],['up'],['down'],['move',10,10],['up']]);
   await page.evaluate(()=>{window.padEvents=[];});
   await surface.evaluate(el=>{
     const emit=(type,id,x,y)=>el.dispatchEvent(new PointerEvent(type,{pointerId:id,clientX:x,clientY:y,bubbles:true,pointerType:'touch'}));
     emit('pointerdown',1,100,100); emit('pointerdown',2,200,100);
     emit('pointermove',2,200,120); emit('pointerup',2,200,120); emit('pointermove',1,110,100); emit('pointerup',1,110,100);
   });
   assert.deepEqual(await page.evaluate(()=>window.padEvents), [['scroll',-40]]);
   await surface.evaluate(el=>{
     const emit=(type)=>el.dispatchEvent(new PointerEvent(type,{pointerId:1,clientX:100,clientY:100,bubbles:true,pointerType:'touch'}));
     emit('pointerdown');emit('pointerup');emit('pointerdown');emit('pointercancel');emit('pointercancel');
   });
   assert.deepEqual((await page.evaluate(()=>window.padEvents)).slice(-4), [['down'],['up'],['down'],['up']]);
   await surface.evaluate(el=>{
     const emit=type=>el.dispatchEvent(new PointerEvent(type,{pointerId:1,clientX:100,clientY:100,bubbles:true,pointerType:'touch'}));
     emit('pointerdown');emit('pointerup');emit('pointerdown');
   });
   await page.locator('#toolbar').click();
   assert.equal((await page.evaluate(()=>window.padEvents)).at(-1)[0], 'up');
 }
 assert.equal(await page.locator('canvas').evaluate(c=>c.getContext('2d').getImageData(20,200,1,1).data[0]),229);
 console.log('PASS: portrait/landscape all-margin gestures, cursor alignment, cancellation, no remote input, stable toolbar.');
} finally {await browser?.close(); await new Promise(r=>server.close(r));}
