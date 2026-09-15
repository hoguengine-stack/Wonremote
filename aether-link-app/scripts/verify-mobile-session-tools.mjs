import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const source = readFileSync('src/App.tsx', 'utf8');
const start = source.indexOf('      {mobileRemote && mobileToolsOpen && <button className="mobile-tools-backdrop"');
const toolbar = source.slice(start, source.indexOf('\n    </section>', start));
assert.ok(start > 0 && toolbar.includes('session-tool-menu-content'));
const bundle = await build({stdin: {resolveDir: process.cwd(), loader: 'tsx', contents: `
import React, {useState, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {X, LayoutDashboard, RotateCcw, ZoomOut, ZoomIn, Clipboard, SlidersHorizontal, ChevronDown, Power, MessageSquare, Volume2, Video, FileUp, Download, FolderOpen, MousePointerClick, Minimize2, Maximize2, LogOut} from 'lucide-react';
import {MobileRemoteControls} from './src/components/MobileRemoteControls';
import {sessionConnectionStatus} from './src/domain/sessionConnectionStatus';
function App() {
 const mobileRemote=true;
 const [mobileToolsOpen,setMobileToolsOpen]=useState(false), [zoom,setZoom]=useState(1);
 const [streamPerformanceMode,selectStreamPerformanceMode]=useState('auto');
 const [selectedDisplayIndex,handleSwitchDisplay]=useState(0);
 const [isChatOpen,setIsChatOpen]=useState(false);
 const [rebootReconnectState,setRebootReconnectState]=useState('idle');
 const [needsManualReconnect,setNeedsManualReconnect]=useState(false);
 const [generation,setWebRtcReconnectGeneration]=useState(0);
 const [mobileInputMode,setMobileInputMode]=useState('screen');
 const device={desktopName:'DESKTOP-LONG-DEVICE-NAME',storeName:'테스트 매장',displays:[{index:0,width:1920,height:1080,name:'긴 이름의 주 모니터',primary:true}]};
 const isWebRtcConnectionReady=true, isSessionFullscreen=false, isRecording=false, chatMessages=[], latencyReport='';
 const picturePresented=true, pictureError='', receiveError='', isFirebaseMode=true;
 const isVisible=true, isActive=true, sessionId='session-1', reconnectBusy=false, portraitRemote=true;
 const connectionStatus=sessionConnectionStatus({restarting:false,reconnecting:false,disconnected:false,transportReady:true,picturePresented,pictureError,receiveError});
 const fileInputRef=useRef(null),folderInputRef=useRef(null);
 const imeInputRef=useRef(null),lastPointerPointRef=useRef({dx:0,dy:0});
 const reverseReceiverRef=useRef(null),receivedFileRef=useRef(null),incomingProgressRef=useRef(null);
 window.actions=window.actions||[];
 const action=(name)=>()=>window.actions.push(name);
 const showDeviceList=action('devices'),leaveRemoteSession=action('leave'),toggleSessionFullscreen=action('fullscreen');
 const handleSendClipboard=action('clipboard-send'),handleFetchClipboard=action('clipboard-fetch');
 const onInputEvent=(command)=>window.actions.push(command),buildMouseCommand=(kind,_x,_y,button,delta)=>kind==='wheel'?'wheel '+delta:kind+button;
 const handleSystemCommand=(command)=>window.actions.push(command);
 const triggerBeepSound=action('sound'),stopRecording=action('stop-recording'),startRecording=action('recording');
 const handleFileUpload=action('file'),startVisualPing=action('ping'),remoteFileLimitLabel=()=>'500MB';
 const setFitZoom=()=>setZoom(1),setActualSizeZoom=()=>setZoom(2);
 const reconnectSession=async()=>{},isViewerFirebaseEnabled=()=>false,getReverseReceiver=()=>({restore:async()=>null});
 const setReceivedFile=()=>{},setInterruptedFile=()=>{},setSessionDataError=()=>{},setMobileKeyboardEnabled=()=>{};
 const reverseFileSupported=true,receivedFile=null,receivedDownloadRequested=true,desktopDownloads=false,downloadFolder='';
 const setDownloadFolder=()=>{},invoke=async()=>'',androidFileExporter={available:()=>true};
 const DANGEROUS_SYSTEM_COMMANDS=new Set(['restart','shutdown','logoff']);
 return <main className="mobile-viewer remote-focus-mode"><section className={'session-panel mobile-session'+(mobileToolsOpen?' mobile-tools-open':'')} data-testid="remote-session-workspace">
 <div className="remote-work-area"><div className="remote-preview portrait-remote-preview mobile-width-fit-preview"><canvas width="1920" height="1080" style={{background:'#b8c8ce',transform:'scale('+zoom+')',transformOrigin:'center top'}}/></div></div>
 <MobileRemoteControls send={c=>window.actions.push(c)} click={b=>window.actions.push('click'+b)} scroll={d=>window.actions.push('scroll'+d)} keyboard={action('keyboard')} zoom={d=>setZoom(z=>z+d)} settings={()=>setMobileToolsOpen(o=>!o)} settingsOpen={mobileToolsOpen} closeSettings={()=>setMobileToolsOpen(false)}/>
 ${toolbar}
 </section></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`}, bundle:true, write:false, jsx:'automatic'});
const html = `<meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><style>${readFileSync('src/styles.css','utf8')}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`;
writeFileSync('../.codex-tmp/mobile-tools-preview.html', html);
const browser = await chromium.launch({channel:'msedge', headless:true});
try {
 const page = await browser.newPage({hasTouch:true});
 const errors=[]; page.on('pageerror',e=>{ errors.push(e.message); console.error(e.message); });
 for(const [width,height] of [[320,640],[360,800],[412,915],[800,360],[360,430]]) {
  await page.setViewportSize({width,height});
  await page.setContent(html);
  const bar=page.locator('.mobile-remote-controls');
  await page.getByRole('button',{name:'화면 및 세션 설정',exact:true}).waitFor();
  const before=await bar.boundingBox();
  const primary = await page.locator('.mobile-touch-bar').boundingBox();
  assert.ok(primary.height <= (width>height?60:108), 'primary toolbar must remain compact');
  assert.ok(before.height <= (width>height?108:156), 'favorites add at most one 48px row');
  assert.equal(await page.locator('.remote-command-bar').isVisible(),false);
  await page.getByRole('button',{name:'화면 및 세션 설정',exact:true}).tap();
  const after=await bar.boundingBox();
  assert.deepEqual(after,before,'opening tools must not move primary controls');
  const panel=page.locator('.remote-command-bar');
  const bounds=await panel.boundingBox();
  assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=width && bounds.y+bounds.height<=before.y,'panel inside usable viewport');
  assert.equal(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth),true,'no horizontal panel overflow');
  const display=page.getByTestId('display-mode-controls');
  await display.scrollIntoViewIfNeeded();
  assert.ok((await display.boundingBox()).height>=88,'display settings must not collapse in flex layout');
  await page.getByRole('button',{name:'Fit',exact:true}).tap();
  await page.getByRole('combobox',{name:'모니터 선택',exact:true}).selectOption('0');
  const buttons=panel.locator('button');
  for(let i=0;i<await buttons.count();i++) {
   const button=buttons.nth(i);
   if(!await button.isVisible()) continue;
   await button.scrollIntoViewIfNeeded();
   assert.equal(await button.evaluate(e=>e.scrollWidth<=e.clientWidth),true,'button text fits');
   const b=await button.boundingBox();
   assert.ok(b.x>=0 && b.x+b.width<=width,'every tool horizontally reachable');
  }
  await page.getByRole('button',{name:'원격 PC → 내 PC',exact:true}).tap();
  assert.ok((await page.evaluate(()=>window.actions)).includes('clipboard-fetch'));
  await panel.evaluate(e=>e.scrollTop=0);
  await page.screenshot({path:'../.codex-tmp/mobile-session-tools-'+width+'x'+height+'.png'});
  await page.getByRole('button',{name:'Windows 특수키',exact:true}).tap();
  assert.equal(await panel.isVisible(),false,'Fn replaces settings, not stacks');
  await page.getByRole('button',{name:'Ctrl',exact:true}).tap();
  await page.getByRole('button',{name:'화면 및 세션 설정',exact:true}).tap();
  await page.locator('.mobile-key-panel').waitFor({state:'detached'});
  assert.equal(await page.locator('.mobile-key-panel').count(),0);
  assert.ok((await page.evaluate(()=>window.actions)).includes('key-up Ctrl'));
  await page.getByRole('button',{name:'도구 닫기',exact:true}).tap();
  assert.equal(await panel.isVisible(),false);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: actual App toolbar JSX/full CSS; 5 portrait/landscape/keyboard-sized viewports; bounded tools, readable buttons, fixed primary toolbar, exclusive Fn/settings, clipboard callback.');
} finally { await browser.close(); }
