import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import ts from "typescript";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { App } from "./src/App"; window.root = createRoot(document.getElementById("root")); window.root.render(<React.StrictMode><App /></React.StrictMode>);',
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, outfile: "viewer-test.js", platform: "browser", format: "iife",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "offline-firebase-boundary", setup(builder) {
      builder.onLoad({ filter: /[\\/]firebase[\\/]viewerFirebase\.ts$/ }, ({ path }) => {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
        const names = source.statements.filter(ts.isFunctionDeclaration)
          .filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
          .map((node) => node.name!.text);
        return { contents: names.map((name) => `export const ${name} = (...args) => window.testApi.${name}(...args);`).join("\n") };
      });
    } }],
  });
  bundle = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); });

async function openViewer(options: { slow?: boolean; fail?: boolean; local?: boolean; connected?: boolean; mobile?: boolean; emulateMobile?: boolean; rolloutSupported?: boolean; nativeAndroid?: boolean; desktop?: boolean; accountManager?: boolean; viewport?: { width: number; height: number }; storeName?: string } = {}) {
  const page = await browser.newPage({ viewport: options.viewport ?? (options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }), ...(options.emulateMobile ? { isMobile: true, hasTouch: true } : {}), ...(options.nativeAndroid ? { userAgent: "Android WonRemoteViewer/1" } : {}) });
  const origin = options.nativeAndroid ? "https://wonremote-a7fd3.web.app" : "http://viewer.test";
  page.setDefaultTimeout(3_000);
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${origin}/${options.mobile ? "viewer" : ""}`) return route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width, initial-scale=1.0"><div id="root"></div>' });
    if (options.local && url.endsWith("/api/admin/login") && route.request().method() === "POST") return route.fulfill({ json: {}, headers: { "access-control-allow-origin": "*" } });
    if (options.local && new URL(url).pathname === "/api/devices") {
      const devices = await page.evaluate(() => (window as any).testApi.fetchFirebaseDevices());
      return route.fulfill({ json: { devices }, headers: { "access-control-allow-origin": "*" } });
    }
    if (options.local && route.request().method() === "OPTIONS") {
      return route.fulfill({ headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    }
    if (options.local && options.connected && new URL(url).pathname === "/api/sessions") {
      return route.fulfill({json:{session:{id:'local-session',deviceId:'device-0',state:'connected',startedAt:new Date().toISOString()},inputLog:[]},headers:{'access-control-allow-origin':'*'}});
    }
    return route.abort();
  });
  await page.goto(`${origin}/${options.mobile ? "viewer" : ""}`);
  await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
  await page.clock.install();
  await page.evaluate((opts) => {
    const w = window as any;
    if (opts.desktop) {
      w.nativeCalls = []; w.nativeChunks = [];
      w.nativeCallbacks = []; w.nativeEvents = {};
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
      w.__TAURI_INTERNALS__ = {
        metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}},
        transformCallback: (callback:unknown) => w.nativeCallbacks.push(callback)-1,
        invoke: async (command:string,args:any) => {
          w.nativeCalls.push({command,args});
          if (command === "plugin:event|listen") { w.nativeEvents[args.event]=w.nativeCallbacks[args.handler]; return args.handler; }
          if (command === "get_app_mode") return "viewer";
          if (command === "begin_viewer_download") return "local-save";
          if (command === "write_viewer_download") { w.nativeChunks.push(args.data); return; }
          if (command === "finish_viewer_download") { if (w.failNativeSave) throw Error("Disk full"); return "C:/Downloads/received.txt"; }
          if (command === "choose_viewer_download_folder") return "C:/Downloads";
          if (command === "check_selected_viewer_update") return {available:Boolean(w.selectedUpdateAvailable)};
          return 1;
        },
      };
    }
    const state = w.testState = {
      reads: 0, subscriptions: 0, connections: [] as string[], closedSessions: [] as string[], slow: Boolean(opts.slow), fail: Boolean(opts.fail),
      auxiliaryReads: 0, auxiliarySubscriptions: [] as any[], auxiliaryStops: 0,
      historyReads: 0, historySubscriptions: 0, rtcStarts: 0, controls: [] as unknown[],
      devices: Array.from({ length: 10 }, (_, i) => ({
        id: `device-${i}`, deviceNumber: `AGENT-${i}`, businessNumber: "123-45-67890",
        desktopName: `PC-${i}`, deviceName: "POS", storeName: opts.storeName ?? "Store", status: i === 9 ? "online" : "offline", protocolVersion: 1,
        lastSeenAt: new Date().toISOString(),
        ...(opts.rolloutSupported ? {version:"0.1.93",selectedRolloutVersion:"0.1.93",rollbackSupportVersion:"0.1.93"} : {}),
      })),
    };
    w.testApi = new Proxy({
      isViewerFirebaseEnabled: () => !opts.local,
      subscribeViewerAuthState: (next: (authenticated: boolean) => void) => {
        w.authChanged = next; next(true); return () => {};
      },
      subscribeFirebaseDevices: (next: (devices: unknown[]) => void) => {
        state.subscriptions++; next(structuredClone(state.devices)); return () => {};
      },
      subscribeFirebaseConnectionHistory: (next: (history: unknown[]) => void) => { state.historySubscriptions++; next([]); return () => {}; },
      fetchFirebaseConnectionHistory: async () => { state.historyReads++; return w.historyFixture ?? []; },
      isCurrentViewerAccountManager: async () => Boolean(opts.accountManager),
      fetchFirebaseDevices: async (_env?: unknown, refreshPresence = false, _signal?: AbortSignal, onProgress?: (devices: unknown[]) => void) => {
        state.reads++;
        const devices = structuredClone(state.devices);
        if (refreshPresence && w.refreshProgressAllOnline) {
          onProgress?.(devices.map((device: any) => ({ ...device, status: "online" })));
          await new Promise<void>((resolve) => { w.finishPresenceRefresh = resolve; });
          delete w.finishPresenceRefresh;
        }
        if (state.slow) await new Promise<void>((resolve) => { w.finishRead = resolve; });
        if (state.fail) throw new Error("Quota exceeded.");
        return devices;
      },
      openFirebaseSession: async (id: string) => {
        state.connections.push(id);
        if (opts.connected) return { session: { id: `remote-session-${id}-${state.connections.length}`, deviceId: id, state: "connected", startedAt: new Date().toISOString() }, inputLog: [] };
        throw new Error("Current target is offline.");
      },
      startFirebaseViewerWebRtcTransport: async (_id: string, callbacks: any) => {
        state.rtcStarts++; w.rtcCallbacks = callbacks;
        callbacks.onState("webrtc-open");
        return { close: () => {}, isControlReady: () => true, sendControl: (value: unknown) => { if (w.failControl) return false; state.controls.push(value); return true; }, sendFile: async (input:unknown) => w.testSendFile ? w.testSendFile(input) : false };
      },
      getFirebaseViewerStorageOwner: () => "test-viewer-owner",
      subscribeViewerSessionData: (_id: string, next: (data: any) => void, _error: unknown, options: unknown) => {
        state.auxiliarySubscriptions.push({ next, options }); return () => { state.auxiliaryStops++; };
      },
      fetchFirebaseChatMessages: async () => { state.auxiliaryReads++; return []; },
      fetchFirebaseClipboardText: async () => { state.auxiliaryReads++; return []; },
      fetchFirebaseFiles: async () => { state.auxiliaryReads++; return []; },
      fetchFirebaseFileTransferReceipts: async () => { state.auxiliaryReads++; return []; },
      requestFirebaseSecureSession: async (id: string) => { state.connections.push(`secure:${id}`); throw new Error("Current target is offline."); },
      closeFirebaseSession: async (id: string) => { state.closedSessions.push(id); },
      logoutViewerWithFirebase: async () => { w.authChanged(false); },
    }, { get(target, key) { return (target as any)[key] ?? (async () => null); } });
  }, options);
  await page.addScriptTag({ content: bundle });
  if (options.local) {
    await page.locator('input[name="username"]').fill("test");
    await page.locator('input[name="password"]').fill("test");
    await page.locator('button[type="submit"]').first().click();
  }
  return page;
}

const counts = (page: Page) => page.evaluate(() => {
  const state = (window as any).testState;
  return { reads: state.reads, subscriptions: state.subscriptions };
});
const refresh = (page: Page) => page.getByRole("button", { name: "장비 목록 새로고침", exact: true });

describe("manual Viewer device list in a real browser", () => {
  it("keeps editor keyboard focus when the remote transport becomes ready", async () => {
    const page = await openViewer({ desktop: true, connected: true });
    try {
      await page.evaluate(() => {
        const w = window as any;
        const open = w.testApi.openFirebaseSession;
        w.testApi.openFirebaseSession = (id: string) => new Promise(resolve => {
          w.releaseEditorSession = async () => resolve(await open(id));
        });
        const start = w.testApi.startFirebaseViewerWebRtcTransport;
        w.testApi.startFirebaseViewerWebRtcTransport = (id: string, callbacks: any) => {
          w.releaseEditorTransport = () => callbacks.onState('webrtc-open');
          return start(id, { ...callbacks, onState: () => {} });
        };
      });
      await page.locator('.table-row').filter({ hasText: 'PC-0' }).getByRole('button', { name: '접속', exact: true }).click();
      await page.waitForFunction(() => !!(window as any).releaseEditorSession);
      await page.locator('.table-row').filter({ hasText: 'PC-0' }).click({ button: 'right' });
      const dialog = page.getByRole('dialog', { name: '등록 장비 수정', exact: true });
      const input = dialog.getByLabel('가맹점 상호명');
      await input.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Local');
      expect(await input.inputValue()).toBe('Local');
      await page.evaluate(() => (window as any).releaseEditorSession());
      await page.waitForFunction(() => !!(window as any).releaseEditorTransport);
      await page.evaluate(() => (window as any).releaseEditorTransport());
      await page.clock.runFor(50);
      expect(await input.evaluate(element => document.activeElement === element)).toBe(true);
      await page.evaluate(() => { (window as any).testState.controls = []; });
      await page.keyboard.type(' edit');
      await page.keyboard.press('Backspace');
      expect(await input.inputValue()).toBe('Local edi');
      expect(await page.evaluate(() => (window as any).testState.controls)).toEqual([]);
      await dialog.getByRole('button', { name: '취소', exact: true }).click();
      await expect.poll(() => page.locator('.remote-ime-input').evaluate(element => document.activeElement === element)).toBe(true);
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => (window as any).testState.controls)).toEqual(['key-down Right', 'key-up Right']);
    } finally { await page.close(); }
  });
  it("keeps typed text in the right-click device editor and saves it", async () => {
    const page = await openViewer({ desktop: true });
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.editorWrites = [];
        w.testApi.updateFirebaseDeviceMetadata = async (id: string, input: any) => {
          w.editorWrites.push('metadata');
          const device = w.testState.devices.find((item: any) => item.id === id);
          Object.assign(device, input);
          return { ...device };
        };
        w.testApi.updateFirebaseDeviceRollout = async () => {
          w.editorWrites.push('rollout');
          throw new Error('업데이트 설정 저장 실패');
        };
      });
      await page.locator('.table-row').filter({hasText:'PC-0'}).click({button:'right'});
      const dialog = page.getByRole('dialog', {name:'등록 장비 수정', exact:true});
      const store = dialog.getByLabel('가맹점 상호명');
      await store.fill('수정 매장');
      await expect.poll(() => store.inputValue()).toBe('수정 매장');
      await store.press('End');
      await store.pressSequentially(' ABC');
      await expect.poll(() => store.inputValue()).toBe('수정 매장 ABC');
      const desktop = dialog.getByLabel('데스크탑명');
      await desktop.fill('수정 PC');
      await expect.poll(() => desktop.inputValue()).toBe('수정 PC');
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('업데이트 설정 저장 실패');
      expect(await desktop.inputValue()).toBe('수정 PC');
      await page.evaluate(() => {
        const w = window as any;
        w.testApi.updateFirebaseDeviceRollout = async () => { w.editorWrites.push('rollout'); };
      });
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect.poll(() => dialog.count()).toBe(0);
      await expect.poll(() => page.locator('.table-row').filter({ hasText: '수정 PC' }).count()).toBe(1);
      expect(await page.evaluate(() => (window as any).editorWrites)).toEqual(['metadata', 'rollout', 'metadata', 'rollout']);
    } finally { await page.close(); }
  });
  it("shows metadata failure in the device editor without losing text or writing rollout", async () => {
    const page = await openViewer({ desktop: true });
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.editorWrites = [];
        w.testApi.updateFirebaseDeviceMetadata = async () => {
          w.editorWrites.push('metadata');
          throw new Error('장비 정보 저장 권한 없음');
        };
        w.testApi.updateFirebaseDeviceRollout = async () => { w.editorWrites.push('rollout'); };
      });
      await page.locator('.table-row').filter({ hasText: 'PC-0' }).click({ button: 'right' });
      const dialog = page.getByRole('dialog', { name: '등록 장비 수정', exact: true });
      await dialog.getByLabel('담당자', { exact: true }).fill('수정 담당자');
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('장비 정보 저장 권한 없음');
      expect(await dialog.getByLabel('담당자', { exact: true }).inputValue()).toBe('수정 담당자');
      expect(await page.evaluate(() => (window as any).editorWrites)).toEqual(['metadata']);
      expect(await dialog.getByRole('button', { name: '저장', exact: true }).isEnabled()).toBe(true);
    } finally { await page.close(); }
  });
  it("keeps the pre-click mixed statuses visible until presence refresh completes", async () => {
    const page = await openViewer();
    const online = page.locator(".table-row .status-pill.online");
    const offline = page.locator(".table-row .status-pill.offline");
    try {
      await expect.poll(() => online.count()).toBe(1);
      expect(await offline.count()).toBe(9);
      await page.evaluate(() => { (window as any).refreshProgressAllOnline = true; });
      await refresh(page).click();
      await page.waitForFunction(() => typeof (window as any).finishPresenceRefresh === "function");
      expect(await online.count()).toBe(1);
      expect(await offline.count()).toBe(9);
      await page.evaluate(() => (window as any).finishPresenceRefresh());
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      expect(await online.count()).toBe(1);
      expect(await offline.count()).toBe(9);
    } finally {
      await page.close();
    }
  });

  it.each([1024, 1366, 1920])("keeps a long Agent update result clear of the heading, tools and dashboard at %ipx", async (width) => {
    const page = await openViewer({ desktop: true, accountManager: true, viewport: { width, height: 768 }, storeName: "김미자 본오(방구석)" });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.getByRole("button", { name: /김미자 본오/ }).first().click();
      await page.getByRole("button", { name: "에이전트 업데이트 요청", exact: true }).first().click();
      const notice = page.getByText(/업데이트 요청을 전송했습니다/, { exact: false });
      await notice.waitFor();
      expect(await notice.evaluate((element) => element.closest(".viewer-command-header") === null)).toBe(true);

      const boxes = await Promise.all([
        page.locator(".workspace-heading-line").boundingBox(),
        page.locator(".viewer-command-header .topbar-tools").boundingBox(),
        notice.boundingBox(),
        page.locator('[data-testid="device-workspace"]').boundingBox(),
      ]);
      expect(boxes.every(Boolean)).toBe(true);
      const [heading, tools, status, dashboard] = boxes as NonNullable<(typeof boxes)[number]>[];
      const overlaps = (a: typeof heading, b: typeof heading) =>
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(overlaps(heading, tools)).toBe(false);
      expect(overlaps(status, tools)).toBe(false);
      expect(overlaps(status, dashboard)).toBe(false);
      expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("retries failed selected Viewer installation only after cooldown", async () => {
    const page=await openViewer({desktop:true,connected:true});
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(()=>{(window as any).selectedUpdateAvailable=true;});
      await page.clock.runFor(10000);
      await page.waitForFunction(()=>(window as any).nativeCalls.some((x:any)=>x.command==='start_installer_update'));
      await page.evaluate(()=>{(window as any).nativeEvents['selected-viewer-update-finished']({payload:null});});
      await page.getByText('자동 업데이트가 적용되지 않았습니다. 업데이트 확인에서 결과를 확인하세요.',{exact:true}).waitFor();
      await page.clock.runFor(3590000);
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((x:any)=>x.command==='start_installer_update').length)).toBe(1);
      await page.clock.runFor(60000);
      await expect.poll(()=>page.evaluate(()=>(window as any).nativeCalls.filter((x:any)=>x.command==='start_installer_update').length)).toBe(2);
    } finally { await page.close(); }
  });
  it("commits Korean composition before masked Ctrl shortcuts and Hangul toggle", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.locator('[data-remote-ime-input="true"]').waitFor({state:'attached'});
      const result = await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-remote-ime-input="true"]')!;
        const w=window as any; w.testState.controls=[];
        input.focus();
        const compose=(text:string)=>{
          input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
          input.value=text;
          input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:text}));
        };
        const key=(type:string,key:string,code:string,ctrlKey=false,isComposing=false)=>input.dispatchEvent(new KeyboardEvent(type,{bubbles:true,cancelable:true,key,code,ctrlKey,isComposing}));
        compose('한');
        key('keydown','Process','ControlLeft',true,true);
        key('keydown','Process','KeyA',true,true);
        key('keyup','a','KeyA',true);
        key('keyup','Control','ControlLeft');
        input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'ㅎ'}));
        input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한'}));
        const shortcut=[...w.testState.controls];
        compose('글');
        key('keydown','Process','Lang1',false,true);
        const afterToggle=input.value;
        key('keyup','HangulMode','Lang1');
        input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'글'}));
        return {shortcut,afterToggle,all:w.testState.controls};
      });
      expect(result.shortcut).toEqual(['text-replace-base64 0 7ZWc','key-down Ctrl','key-down A','key-up A','key-up Ctrl']);
      expect(result.afterToggle).toBe('');
      expect(result.all).toEqual([...result.shortcut,'text-replace-base64 0 6riA']);
      await page.evaluate(() => {
        const input=document.querySelector<HTMLTextAreaElement>('[data-remote-ime-input="true"]')!;
        const dispatch=(type:string,key:string,code:string,flags:KeyboardEventInit={})=>input.dispatchEvent(new KeyboardEvent(type,{bubbles:true,cancelable:true,key,code,...flags}));
        (window as any).testState.controls=[];
        dispatch('keydown','Process','ShiftLeft',{shiftKey:true,isComposing:true});
        dispatch('keydown','ArrowLeft','ArrowLeft',{shiftKey:true});
        dispatch('keyup','ArrowLeft','ArrowLeft',{shiftKey:true});
        dispatch('keyup','Shift','ShiftLeft');
      });
      expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual(['key-down Shift','key-down Left','key-up Left','key-up Shift']);
      await page.evaluate(() => { (window as any).testState.controls=[]; });
      await page.keyboard.press('Control+c');
      await page.keyboard.press('Control+v');
      expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual(['key-down Ctrl','key-down C','key-up C','key-up Ctrl','key-down Ctrl','key-down V','key-up V','key-up Ctrl']);
    } finally { await page.close(); }
  });
  it("releases keyboard focus and pointer capture when the live transport disconnects", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.locator('.table-row').filter({ has: page.getByText('PC-0', { exact: true }) }).getByRole('button', { name: '접속', exact: true }).click();
      const input = page.locator('[data-remote-ime-input="true"]');
      const canvas = page.locator('.remote-canvas');
      await input.waitFor({ state: 'attached' });
      await page.evaluate(() => {
        const element = document.querySelector<HTMLCanvasElement>('.remote-canvas')!;
        element.addEventListener('pointerdown', event => { (window as any).testPointerId = event.pointerId; }, { once: true, capture: true });
        (window as any).testState.controls = [];
      });
      await page.keyboard.down('Control');
      const box = await canvas.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await expect.poll(() => page.evaluate(() => (window as any).testState.controls)).toEqual(expect.arrayContaining(['key-down Ctrl']));
      await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error('Disconnected')));
      await page.getByRole('dialog', { name: '원격 연결 끊김' }).waitFor();

      const result = await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-remote-ime-input="true"]')!;
        const canvas = document.querySelector<HTMLCanvasElement>('.remote-canvas')!;
        const pointerId = (window as any).testPointerId;
        (window as any).testState.controls = [];
        const keyAllowed = window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', code: 'KeyA' }));
        const wheelAllowed = canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
        return {
          controls: (window as any).testState.controls,
          inputMode: input.inputMode,
          pointerCaptured: typeof pointerId === 'number' && canvas.hasPointerCapture(pointerId),
          readOnly: input.readOnly,
          remoteInputFocused: document.activeElement === input,
          keyAllowed,
          wheelAllowed,
        };
      });
      expect(result).toEqual({ controls: [], inputMode: 'none', pointerCaptured: false, readOnly: true, remoteInputFocused: false, keyAllowed: true, wheelAllowed: true });
      await page.mouse.up();
      await page.keyboard.up('Control');
    } finally { await page.close(); }
  });
  it("automatically commits PC received files and opens only the local destination", async () => {
    const page = await openViewer({connected:true,desktop:true});
    try {
      await page.getByText("PC-0",{exact:true}).waitFor();
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})}).getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => Boolean((window as any).rtcCallbacks));
      const text="local automatic save", sha=createHash("sha256").update(text).digest("hex");
      await page.evaluate(chunk=>(window as any).rtcCallbacks.onFileChunk(chunk,()=>true),{type:"file-chunk",transferId:"native-auto",filename:"received.txt",chunkIndex:0,totalChunks:1,totalBytes:Buffer.byteLength(text),isLast:true,fileData:Buffer.from(text).toString("base64"),chunkSha256:sha,fileSha256:sha});
      await page.getByText("저장 완료 · C:/Downloads/received.txt",{exact:true}).waitFor();
      await page.getByRole("button",{name:"내 PC 받은 폴더 열기",exact:true}).click();
      await page.getByRole("button",{name:"기본 다운로드 폴더 설정",exact:true}).click();
      const result=await page.evaluate(()=>({calls:(window as any).nativeCalls.map((x:any)=>x.command),chunks:(window as any).nativeChunks,controls:(window as any).testState.controls}));
      expect(result.calls.filter((x:string)=>x==="finish_viewer_download")).toHaveLength(1);
      expect(result.calls).toContain("open_viewer_download_folder");
      expect(result.calls).toContain("choose_viewer_download_folder");
      expect(result.controls).not.toContain("open-download-folder");
      expect(Buffer.from(result.chunks.join(""),"base64").toString()).toBe(text);
    } finally { await page.close(); }
  });
  it("shows local HTTP tile failure and recovers only after a successful response", async () => {
    const page = await openViewer({local:true,connected:true});
    let failed = false;
    let holdNext = false;
    let pending: import("playwright").Route | undefined;
    try {
      await page.route('**/api/sessions/local-session/tiles', async route => {
        if (holdNext) { holdNext=false; pending=route; return; }
        await route.fulfill({status:failed?503:200,headers:{'access-control-allow-origin':'*'},json:failed?{}:{width:32,height:32,tiles:[]}});
      });
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.getByText('Store · 화면 수신 대기',{exact:true}).waitFor();
      holdNext=true;
      await page.clock.runFor(100);
      await expect.poll(() => Boolean(pending)).toBe(true);
      failed=true;
      await page.clock.runFor(200);
      await page.getByText('Store · 화면 수신 오류',{exact:true}).waitFor();
      await pending!.fulfill({headers:{'access-control-allow-origin':'*'},json:{width:32,height:32,tiles:[]}});
      await page.clock.runFor(50);
      expect(await page.getByText('Store · 화면 수신 오류',{exact:true}).isVisible()).toBe(true);
      failed=false;
      await page.clock.runFor(200);
      await page.getByText('Store · 화면 수신 대기',{exact:true}).waitFor();
      expect(await page.evaluate(() => (window as any).testState.rtcStarts)).toBe(0);
    } finally {await page.close();}
  });
  it("expands device notes from already loaded metadata", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => { (window as any).testState.devices[0].notes = "프린터 케이블 점검\n다음 방문 확인"; });
      await refresh(page).click();
      const row = page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) });
      await row.locator("summary").filter({ hasText: "작업 메모" }).click();
      expect(await row.locator(".device-row-notes p").isVisible()).toBe(true);
      expect(await row.locator(".device-row-notes p").innerText()).toContain("다음 방문 확인");
      await row.locator("summary").filter({ hasText: "작업 메모" }).click();
      expect(await row.locator(".device-row-notes p").isVisible()).toBe(false);
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });
  it("saves, finds and clears a contact phone in the device list", async () => {
    const page = await openViewer();
    try {
      await page.evaluate(() => {
        (window as any).testApi.updateFirebaseDeviceMetadata = async (id: string, input: any) => {
          const device = (window as any).testState.devices.find((item: any) => item.id === id);
          Object.assign(device, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))); return structuredClone(device);
        };
      });
      const row = page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) });
      await row.getByRole("button", { name: "장비 정보 수정", exact: true }).click();
      await page.getByLabel("연락처", { exact: true }).fill("010-1234-5678");
      await page.getByRole("button", { name: "저장", exact: true }).click();
      await row.getByText("010-1234-5678", { exact: true }).waitFor();
      const search = page.getByPlaceholder("매장, 장비, 담당자, 연락처, 메모 검색");
      await search.fill("01012345678");
      await expect.poll(() => page.locator(".device-table > .table-row:not(.table-head)").count()).toBe(1);
      await row.getByRole("button", { name: "장비 정보 수정", exact: true }).click();
      expect(await page.getByLabel("연락처", { exact: true }).inputValue()).toBe("010-1234-5678");
      await page.getByLabel("연락처", { exact: true }).fill("");
      await page.getByRole("button", { name: "저장", exact: true }).click();
      await search.fill("");
      await row.waitFor();
      expect(await row.locator(".device-contact-phone").count()).toBe(0);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
    } finally { await page.close(); }
  });
  it("shares manually loaded successful history with device rows without extra requests", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", {exact:true}).waitFor();
      await page.evaluate(() => {
        (window as any).historyFixture = [
          {id:"older",deviceId:"device-0",status:"success",startedAt:"2026-09-10T01:00:00Z"},
          {id:"rejected",deviceId:"device-0",status:"rejected",startedAt:"2026-09-14T01:00:00Z"},
          {id:"latest",deviceId:"device-0",status:"closed",startedAt:"2026-09-12T01:00:00Z",endedAt:"2026-09-12T01:01:00Z"},
          {id:"invalid",deviceId:"device-0",status:"success",startedAt:"invalid"},
          {id:"denied",deviceId:"device-1",status:"rejected",startedAt:"2026-09-14T01:00:00Z"},
        ];
      });
      const row = page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})});
      expect(await row.locator('time').count()).toBe(0);
      await page.getByRole('button',{name:'연결 이력 새로고침',exact:true}).click();
      await row.locator('time').waitFor();
      expect(await row.locator('time').getAttribute('datetime')).toBe('2026-09-12T01:00:00Z');
      expect(await page.locator('.table-row').filter({has:page.getByText('PC-1',{exact:true})}).locator('time').count()).toBe(0);
      await page.getByRole('combobox',{name:'연결 이력 상태 필터'}).selectOption('rejected');
      expect(await row.locator('time').getAttribute('datetime')).toBe('2026-09-12T01:00:00Z');
      await page.clock.fastForward(86_400_000);
      expect(await page.evaluate(() => (window as any).testState.historyReads)).toBe(1);
      expect(await counts(page)).toEqual({reads:1,subscriptions:0});
      await page.evaluate(() => (window as any).authChanged(false));
      await page.waitForFunction(() => !document.querySelector('.device-recent-connection'));
      await page.evaluate(() => (window as any).authChanged(true));
      await page.getByText('PC-0',{exact:true}).waitFor();
      expect(await row.locator('time').count()).toBe(0);
    } finally { await page.close(); }
  });

  it.each(["getItem", "setItem"])("keeps the remote session usable when device preference %s fails", async operation => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(operation => {
        const stored = JSON.stringify({ zoom: 3, streamPerformanceMode: "normal", selectedDisplayIndex: 2 });
        localStorage.setItem("wonremote-device-view:device-0", stored);
        (window as any).savedPreferenceFixture = stored;
        (window as any).readOriginalPreference = Storage.prototype.getItem.bind(localStorage);
        const original = Storage.prototype[operation];
        (window as any).restorePreferenceStorage = () => { Storage.prototype[operation] = original; };
        Storage.prototype[operation] = function (key: string, ...args: string[]) {
          if (key.startsWith("wonremote-device-view:")) throw new DOMException("Storage unavailable", "QuotaExceededError");
          return original.call(this, key, ...args);
        };
      }, operation);
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      const panel = page.locator(".session-panel:not(.session-panel-inactive)");
      await panel.getByRole("button", { name: "빠름", exact: true }).click();
      expect(await panel.getByRole("button", { name: "빠름", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await page.evaluate(() => (window as any).readOriginalPreference("wonremote-device-view:device-0"))).toBe(await page.evaluate(() => (window as any).savedPreferenceFixture));
      await page.getByText("기기 설정을 저장하지 못했습니다. 현재 연결에는 적용되지만 다음 접속에는 유지되지 않을 수 있습니다.", { exact: true }).waitFor();
      await page.getByTestId("end-session").click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).restorePreferenceStorage());
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await expect.poll(() => panel.getByRole("button", { name: "보통", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await page.getByText("기기 설정을 저장하지 못했습니다. 현재 연결에는 적용되지만 다음 접속에는 유지되지 않을 수 있습니다.", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  });
  it("keeps a first-use monitor selection and restores it after reconnect", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => {
        const device = (window as any).testState.devices[0];
        device.displays = [0, 1].map(index => ({ index, name: `Monitor ${index}`, width: 1920, height: 1080, primary: index === 0 }));
        device.activeDisplayIndex = 1;
      });
      await refresh(page).click();
      const connect = () => page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await connect();
      const select = page.getByRole("combobox", { name: "모니터 선택", exact: true });
      await expect.poll(() => select.inputValue()).toBe("1");
      await select.selectOption("0");
      await expect.poll(() => select.inputValue()).toBe("0");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!).selectedDisplayIndex === 0);
      await page.getByTestId("end-session").click();
      await connect();
      await expect.poll(() => select.inputValue()).toBe("0");
    } finally { await page.close(); }
  });
  it.each([
    { mobile: false, width: 1440, height: 900 },
    { mobile: true, width: 390, height: 844 },
    { mobile: true, width: 844, height: 390 },
  ])("restores desktop zoom or mobile width fit at $width x $height", async ({ mobile, width, height }) => {
    const page = await openViewer({ connected: true, mobile, emulateMobile: mobile });
    try {
      await page.setViewportSize({ width, height });
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => localStorage.setItem("wonremote-device-view:device-0", JSON.stringify({ zoom: 2, streamPerformanceMode: "normal", inputMode: "touchpad" })));
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const source = document.createElement("canvas"); source.width = 1920; source.height = 1080;
        const ctx = source.getContext("2d")!; ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 1920, 1080);
        (window as any).rtcCallbacks.onFrame({ keyframe: true, width: 1920, height: 1080, tiles: [{ x: 0, y: 0, w: 1920, h: 1080, data: source.toDataURL("image/jpeg").split(",")[1] }] });
      });
      const canvas = page.locator(".remote-canvas");
      await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data[0])).toBeGreaterThan(240);
      const scale = await canvas.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a);
      expect(scale).toBe(mobile ? 1 : 2);
      if (mobile) {
        expect(await page.evaluate(() => screen.orientation.type.startsWith("portrait"))).toBe(height > width);
        const size = await canvas.evaluate(node => ({ width: node.getBoundingClientRect().width, available: node.parentElement!.clientWidth }));
        expect(Math.abs(size.width - size.available)).toBeLessThanOrEqual(1);
        if (height > width) {
          const top = await canvas.evaluate(node => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top);
          expect(Math.abs(top)).toBeLessThanOrEqual(1);
        }
      }
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!));
      expect(saved).toMatchObject({ zoom: mobile ? 1 : 2, streamPerformanceMode: "normal", inputMode: "touchpad" });
      if (mobile) await page.screenshot({ path: `.local-run/width-fit-${width}.png` });
    } finally { await page.close(); }
  });
  it("keeps quality preferences separate for each PC", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => {
        localStorage.setItem("wonremote-stream-performance-mode", "normal");
        localStorage.setItem("wonremote-device-view:device-0", JSON.stringify({ streamPerformanceMode: "fast" }));
      });
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      const panel = page.locator(".session-panel:not(.session-panel-inactive)");
      await page.waitForFunction(() => document.querySelector('.session-panel .stream-mode-control button[aria-pressed="true"]')?.textContent?.trim() === "빠름");
      await panel.getByRole("button", { name: "자동", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!).streamPerformanceMode === "auto");
      await panel.getByRole("button", { name: "장비 목록", exact: true }).click();
      await page.locator(".table-row").filter({ has: page.getByText("PC-1", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await panel.getByRole("button", { name: "보통", exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: "보통", exact: true }).getAttribute("aria-pressed")).toBe("true");
      await panel.getByRole("button", { name: "빠름", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-1")!).streamPerformanceMode === "fast");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!).streamPerformanceMode)).toBe("auto");
      expect(await page.evaluate(() => localStorage.getItem("wonremote-stream-performance-mode"))).toBe("normal");
    } finally { await page.close(); }
  });
  it("previews rollout recipients without saving or refreshing devices", async () => {
    const page = await openViewer({rolloutSupported:true});
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => {
        (window as any).savedPolicies = [];
        (window as any).testApi.saveFirebaseUpdateRollout = async (policy: unknown) => { (window as any).savedPolicies.push(policy); };
      });
      await page.getByRole("button", { name: "단계 배포", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "단계 배포 제어" });
      await dialog.getByLabel("대상 버전", { exact: true }).fill("0.1.94");
      await dialog.getByLabel("전체 업데이트 일시 중지").uncheck();
      await dialog.getByRole("button", { name: "General", exact: true }).click();
      await dialog.locator('input[type="range"]').fill("100");
      await dialog.getByText("현재 목록 10대 중 대상 10대", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Canary", exact: true }).click();
      await dialog.getByText("현재 목록 10대 중 대상 0대", { exact: true }).waitFor();
      expect(await dialog.getByText("배포 단계 제외", { exact: true }).count()).toBe(10);
      await dialog.getByRole('checkbox',{name:'선택한 PC에만 배포'}).check();
      await dialog.getByRole('checkbox',{name:'PC-0 배포 대상',exact:true}).check();
      await dialog.getByRole('checkbox',{name:'PC-1 배포 대상',exact:true}).check();
      await dialog.getByText('현재 목록 10대 중 대상 2대',{exact:true}).waitFor();
      expect(await dialog.locator('input[type="range"]').inputValue()).toBe('0');
      expect(await dialog.locator('input[type="range"]').isDisabled()).toBe(true);
      expect(await page.evaluate(() => (window as any).savedPolicies)).toEqual([]);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await dialog.getByRole("button", { name: "정책 저장", exact: true }).click();
      await page.waitForFunction(() => (window as any).savedPolicies.length === 1);
      expect(await page.evaluate(() => (window as any).savedPolicies[0])).toMatchObject({targetDeviceIds:['device-0','device-1'],percentage:0,stage:'general'});
    } finally { await page.close(); }
  });
  it("shows unlisted rollout targets and removes them only after an explicit choice", async () => {
    const page = await openViewer();
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(() => {
        const w=window as any;
        w.savedPolicies=[];
        w.testApi.loadFirebaseUpdateRollout=async()=>({targetVersion:'0.1.94',stage:'general',percentage:0,paused:false,targetDeviceIds:['device-0','hidden-device']});
        w.testApi.saveFirebaseUpdateRollout=async(value:unknown)=>w.savedPolicies.push(value);
      });
      await page.getByRole('button',{name:'단계 배포',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'단계 배포 제어'});
      await dialog.getByText('선택 ID 총 2개 · 현재 목록 밖 1개',{exact:true}).waitFor();
      expect(await dialog.getByText('선택 배포 지원 미확인',{exact:true}).count()).toBe(1);
      expect(await dialog.getByRole('region',{name:'현재 목록 밖 배포 대상'}).innerText()).toContain('hidden-device');
      await dialog.getByRole('button',{name:'정책 저장',exact:true}).click();
      await page.waitForFunction(()=>(window as any).savedPolicies.length===1);
      expect(await page.evaluate(()=>(window as any).savedPolicies[0].targetDeviceIds)).toEqual(['device-0','hidden-device']);
      await page.getByRole('button',{name:'단계 배포',exact:true}).click();
      await dialog.getByRole('button',{name:'hidden-device 배포 대상 제외',exact:true}).click();
      expect(await dialog.getByRole('region',{name:'현재 목록 밖 배포 대상'}).count()).toBe(0);
      await dialog.getByRole('button',{name:'정책 저장',exact:true}).click();
      await page.waitForFunction(()=>(window as any).savedPolicies.length===2);
      expect(await page.evaluate(()=>(window as any).savedPolicies[1].targetDeviceIds)).toEqual(['device-0']);
      expect(await counts(page)).toEqual({reads:1,subscriptions:0});
    } finally {await page.close();}
  });
  it("waits for remote file receipts and applies failure to non-active transfers", async () => {
    const page = await openViewer({connected:true,desktop:true});
    page.on('dialog',dialog=>void dialog.dismiss());
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(() => {
        (window as any).uploads=[];
        (window as any).testApi.uploadFirebaseFileToStorage=async (_session:string,input:any)=>{
          (window as any).uploads.push(input);
          return {storagePath:`test/${input.transferId}`};
        };
      });
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const panel=page.getByTestId('remote-session-workspace');
      await panel.locator('input[type="file"]').first().setInputFiles([
        {name:'first.txt',mimeType:'text/plain',buffer:Buffer.from('first')},
        {name:'second.txt',mimeType:'text/plain',buffer:Buffer.from('second')},
      ]);
      await panel.getByText('원격 저장 확인 중',{exact:true}).first().waitFor();
      await page.waitForFunction(() => (window as any).uploads.length===2);
      await page.waitForFunction(() => document.querySelectorAll('.session-transfer-queue-item.awaiting-receipt').length===2);
      await panel.getByRole('button',{name:'완료 항목 정리',exact:true}).click();
      expect(await panel.getByText('원격 저장 확인 중',{exact:true}).count()).toBe(2);
      expect(await panel.getByText('완료',{exact:true}).count()).toBe(0);
      await page.evaluate(async () => {
        const w=window as any;
        const receipts=w.uploads.map((upload:any,index:number)=>({transferId:upload.transferId,filename:upload.filename,status:index===0?'failed':'received',error:index===0?'disk full':undefined,receivedChunks:1,totalChunks:1}));
        await w.testState.auxiliarySubscriptions.at(-1).next({messages:[],files:[],clipboard:[],receipts});
      });
      await panel.getByText('disk full',{exact:true}).waitFor();
      expect(await panel.getByText('실패',{exact:true}).count()).toBe(1);
      expect(await panel.getByText('완료',{exact:true}).count()).toBe(1);
      await panel.getByRole('button',{name:'내 PC 받은 폴더 열기',exact:true}).click();
      expect(await page.evaluate(() => (window as any).testState.controls.filter((value:string) => value === 'open-download-folder'))).toEqual([]);
      expect(await panel.getByRole('button',{name:'재시도',exact:true}).count()).toBe(1);
      await page.evaluate(() => {
        (window as any).resumedFiles=[];
        (window as any).testSendFile=async (input:any)=>{(window as any).resumedFiles.push({resume:input.resume,id:input.transferId});return true;};
      });
      await panel.getByRole('button',{name:'재시도',exact:true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.session-transfer-queue-item.completed').length===2);
      expect(await page.evaluate(() => (window as any).resumedFiles)).toEqual([{resume:true,id:await page.evaluate(() => (window as any).uploads[0].transferId)}]);
    } finally { await page.close(); }
  });

  it("previews diagnostics before downloading the exact reviewed content", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "장비 진단", exact: true }).click();
      expect(await page.getByRole("button", { name: "파일 저장", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "진단 내보내기", exact: true }).click();
      const preview = await page.getByLabel("저장할 진단 내용").inputValue();
      expect(JSON.parse(preview).schemaVersion).toBe(1);
      expect(preview).not.toContain("123-45-67890");
      const downloadEvent = page.waitForEvent("download");
      await page.getByRole("button", { name: "파일 저장", exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("wonremote-diagnostics.json");
      expect(readFileSync((await download.path())!, "utf8")).toBe(preview);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
    } finally { await page.close(); }
  });
  it("downloads one verified incoming file instead of separate fragments", async () => {
    const page=await openViewer({connected:true});
    const downloads: string[]=[];
    page.on('download',download=>downloads.push(download.suggestedFilename()));
    const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
    const first={id:'part0',transferId:'incoming',filename:'received.txt',chunkIndex:0,totalChunks:2,totalBytes:6,isLast:false,fileData:Buffer.from('abc').toString('base64'),chunkSha256:sha('abc')};
    const last={...first,id:'part1',chunkIndex:1,isLast:true,fileData:Buffer.from('def').toString('base64'),chunkSha256:sha('def'),fileSha256:sha('abcdef')};
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.waitForFunction(()=>(window as any).testState.auxiliarySubscriptions.length>0);
      const deliver=async(file:unknown)=>page.evaluate(async file=>{
        await (window as any).testState.auxiliarySubscriptions.at(-1).next({messages:[],files:[file],clipboards:[],receipts:[]});
      },file);
      await deliver(last);await deliver(last);
      expect(await page.locator('.error-banner').allTextContents()).toEqual([]);
      expect(downloads).toEqual([]);
      const ready=page.waitForEvent('download');await deliver(first);
      const download=await ready;
      expect(readFileSync((await download.path())!,'utf8')).toBe('abcdef');
      await deliver(first);
      expect(downloads).toEqual(['received.txt']);
    } finally {await page.close();}
  });
  it("shows a verified reverse file and downloads only on the explicit save button", async () => {
    const page = await openViewer({ connected: true });
    const downloads: string[] = [];
    page.on("download", file => downloads.push(file.suggestedFilename()));
    const contents = "received from remote PC";
    const sha = createHash("sha256").update(contents).digest("hex");
    const chunk = { type: "file-chunk", transferId: "reverse-ui", filename: "remote.txt", chunkIndex: 0, totalChunks: 1,
      totalBytes: Buffer.byteLength(contents), isLast: true, fileData: Buffer.from(contents).toString("base64"), chunkSha256: sha, fileSha256: sha };
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFileChunk === "function");
      const ack = await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk);
      expect(ack).toMatchObject({ status: "complete", receivedBytes: Buffer.byteLength(contents) });
      await page.getByText("수신 완료 · 저장 대기", { exact: true }).waitFor();
      expect(downloads).toEqual([]);
      const ready = page.waitForEvent("download");
      await page.getByRole("button", { name: "받은 파일 저장", exact: true }).click();
      const download = await ready;
      expect(readFileSync((await download.path())!, "utf8")).toBe(contents);
      await page.getByText("다운로드 요청됨", { exact: true }).waitFor();
      await page.getByRole("button", { name: "수신 항목 정리", exact: true }).click();
      await page.getByRole("button", { name: "받은 파일 저장", exact: true }).waitFor({ state: "detached" });
      expect(downloads).toEqual(["remote.txt"]);
    } finally { await page.close(); }
  });
  it("confirms exact Agent rollback target without submitting the parent device edit form", async () => {
    const page = await openViewer({ rolloutSupported: true });
    try {
      await page.evaluate(() => {
        (window as any).rollbacks = []; (window as any).metadataSaves = 0;
        (window as any).testApi.requestFirebaseAgentRollback = async (...args: unknown[]) => { (window as any).rollbacks.push(args); };
        (window as any).testApi.updateFirebaseDeviceMetadata = async () => { (window as any).metadataSaves++; };
      });
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "장비 정보 수정", exact: true }).click();
      await page.getByRole("button", { name: "에이전트 이전 버전 복구", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "에이전트 이전 버전 복구", exact: true });
      await dialog.getByText("대상 PC: PC-0", { exact: true }).waitFor();
      await dialog.getByLabel("복구할 버전", { exact: true }).fill("0.1.90");
      expect(await dialog.getByRole("button", { name: "복구 실행" }).isDisabled()).toBe(true);
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: "복구 실행" }).click();
      await dialog.getByText("복구 요청됨 · 자동 업데이트 중지 · 세션 종료 후 실행", { exact: true }).waitFor();
      expect(await page.evaluate(() => (window as any).rollbacks)).toEqual([["device-0", "0.1.90"]]);
      expect(await page.evaluate(() => (window as any).metadataSaves)).toBe(0);
      await dialog.getByRole("button", { name: "닫기" }).click();
      expect(await page.getByRole("dialog", { name: "등록 장비 수정", exact: true }).getByRole("checkbox", { name: "이 장비 업데이트 일시 중지" }).isChecked()).toBe(true);
    } finally { await page.close(); }
  });
  it("waits for native saved confirmation from the actual Android save button", async () => {
    const page = await openViewer({ connected: true, nativeAndroid: true });
    const downloads: string[] = [];
    page.on("download", file => downloads.push(file.suggestedFilename()));
    const contents = "Android saved file";
    const sha = createHash("sha256").update(contents).digest("hex");
    try {
      await page.evaluate(() => {
        const channel = new MessageChannel();
        const state: { messages: unknown[]; bytes: string; confirm: (() => void) | null } = { messages: [], bytes: "", confirm: null };
        (window as any).nativeSave = state;
        channel.port1.onmessage = event => {
          const message = JSON.parse(event.data); state.messages.push(message);
          if (message.type === "begin") channel.port1.postMessage(JSON.stringify({ type: "ready", id: message.file.id }));
          if (message.type === "chunk") {
            state.bytes += atob(message.data);
            channel.port1.postMessage(JSON.stringify({ type: "ack", id: message.id, index: message.index, receivedBytes: state.bytes.length }));
          }
          if (message.type === "finish") state.confirm = () => channel.port1.postMessage(JSON.stringify({ type: "saved", id: message.id, receivedBytes: state.bytes.length }));
        };
        window.dispatchEvent(new MessageEvent("message", { data: "wonremote:file-export:1", origin: "", source: null, ports: [channel.port2] }));
      });
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFileChunk === "function");
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), {
        type: "file-chunk", transferId: "native-ui", filename: "remote.txt", chunkIndex: 0, totalChunks: 1,
        totalBytes: Buffer.byteLength(contents), isLast: true, fileData: Buffer.from(contents).toString("base64"), chunkSha256: sha, fileSha256: sha,
      });
      await page.getByText("수신 완료 · 저장 대기", { exact: true }).waitFor();
      expect(await page.evaluate(() => (window as any).nativeSave.messages.length)).toBe(0);
      await page.getByRole("button", { name: "받은 파일 저장", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).nativeSave.confirm === "function");
      await page.getByText("저장 중", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "받은 파일 저장", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByText("파일 저장 완료", { exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => (window as any).nativeSave.bytes)).toBe(contents);
      await page.evaluate(() => (window as any).nativeSave.confirm());
      await page.getByText("파일 저장 완료", { exact: true }).waitFor();
      expect(downloads).toEqual([]);
    } finally { await page.close(); }
  });
  it("sends explicit remote file selection and cancellation from the PC tools menu", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByTestId("secondary-tools").locator("summary").click();
      expect(await page.getByRole("button", { name: "원격 파일 가져오기", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport());
      await page.getByRole("button", { name: "원격 파일 가져오기", exact: true }).click();
      await page.getByRole("button", { name: "가져오기 취소", exact: true }).click();
      expect(await page.evaluate(() => (window as any).testState.controls.filter((value: string) => value.endsWith("file-send"))))
        .toEqual(["request-file-send", "cancel-file-send"]);
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "reverse-ui", state: "selecting" }));
      await page.getByRole("status").filter({ hasText: "원격 PC에서 파일 선택 중" }).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "reverse-ui", state: "selection-failed" }));
      await page.getByText("원격 파일 선택 창을 열지 못했습니다. 로그인된 사용자 화면을 확인해 주세요.", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onState("webrtc-file-closed"));
      expect(await page.getByRole("button", { name: "원격 파일 가져오기", exact: true }).isDisabled()).toBe(true);
    } finally { await page.close(); }
  });
  it("restores a received file on reconnect without exposing it under another Viewer owner", async () => {
    const page = await openViewer({ connected: true });
    const connect = async () => {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFileChunk === "function");
    };
    try {
      await connect();
      const text = "persisted private file", sha = createHash("sha256").update(text).digest("hex");
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), {
        type: "file-chunk", transferId: "restore-ui", filename: "retained.txt", chunkIndex: 0, totalChunks: 1,
        totalBytes: Buffer.byteLength(text), isLast: true, fileData: Buffer.from(text).toString("base64"), chunkSha256: sha, fileSha256: sha,
      });
      await page.getByText("수신 완료 · 저장 대기", { exact: true }).waitFor();
      await page.getByTestId("end-session").click();
      await connect();
      await page.getByTestId("secondary-tools").locator("summary").click();
      await page.getByText("retained.txt", { exact: true }).waitFor();
      const ready = page.waitForEvent("download");
      await page.getByRole("button", { name: "받은 파일 저장", exact: true }).click();
      expect(readFileSync((await (await ready).path())!, "utf8")).toBe(text);
      await page.getByTestId("end-session").click();
      await page.evaluate(() => { (window as any).testApi.getFirebaseViewerStorageOwner = () => "another-viewer"; });
      await connect();
      await page.getByTestId("secondary-tools").locator("summary").click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.getByText("retained.txt", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  });
  it.each([false, true])("shows committed incoming progress without per-chunk redraw and retains exact bytes on failure (mobile=%s)", async mobile => {
    const page = await openViewer({ connected: true, mobile });
    const part = Buffer.alloc(32768, 65);
    const chunk = (index: number) => ({ type: "file-chunk", transferId: "progress-ui", filename: "progress.bin", totalBytes: part.length * 400,
      totalChunks: 400, chunkIndex: index, isLast: false, fileData: part.toString("base64"), chunkSha256: createHash("sha256").update(part).digest("hex") });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFileChunk === "function");
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "progress-ui", state: "sending" }));
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk(0));
      const progress = page.getByRole("progressbar", { name: "파일 수신 진행률" });
      await progress.waitFor();
      const bounds = await progress.boundingBox();
      expect(bounds!.width).toBeGreaterThan(0);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await page.screenshot({ path: `.local-run/incoming-progress-${mobile ? "mobile" : "desktop"}.png` });
      expect(await progress.getAttribute("value")).toBe("32768");
      expect(await page.getByRole("button", { name: "중단된 수신 삭제", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk(1));
      expect(await progress.getAttribute("value")).toBe("32768");
      await page.evaluate(async chunk => {
        try { await (window as any).rtcCallbacks.onFileChunk(chunk, () => true); } catch { /* Expected corrupt chunk rejection. */ }
      }, { ...chunk(2), chunkSha256: "0".repeat(64) });
      await expect.poll(() => progress.getAttribute("value")).toBe("65536");
      expect(await page.getByRole("button", { name: "중단된 수신 삭제", exact: true }).isEnabled()).toBe(true);
      const row = progress.locator("..").locator("..");
      expect(await row.innerText()).toContain("수신 중단됨");
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport(true));
      expect(await page.getByRole("button", { name: "중단된 수신 이어받기", exact: true }).isEnabled()).toBe(true);
      await page.getByRole("button", { name: "중단된 수신 삭제", exact: true }).click();
      await progress.waitFor({ state: "detached" });
    } finally { await page.close(); }
  });
  it("resumes an interrupted receive from its persisted ID only after capability confirmation", async () => {
    const page = await openViewer({ connected: true });
    const bytes = Buffer.concat([Buffer.alloc(32768, 65), Buffer.from("tail")]);
    const first = bytes.subarray(0, 32768), last = bytes.subarray(32768);
    const chunk = (index: number) => ({ type: "file-chunk", transferId: "resume-ui", filename: "resume.bin", totalBytes: bytes.length,
      totalChunks: 2, chunkIndex: index, isLast: index === 1, fileData: (index ? last : first).toString("base64"),
      chunkSha256: createHash("sha256").update(index ? last : first).digest("hex"),
      ...(index ? { fileSha256: createHash("sha256").update(bytes).digest("hex") } : {}) });
    const connect = async () => {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 대기", { exact: true }).waitFor();
    };
    try {
      await connect();
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk(0));
      await page.getByTestId("end-session").click();
      await connect();
      await page.getByTestId("secondary-tools").locator("summary").click();
      const resume = page.getByRole("button", { name: "중단된 수신 이어받기", exact: true });
      await resume.waitFor();
      expect(await resume.isDisabled()).toBe(true);
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport(false));
      expect(await resume.isDisabled()).toBe(true);
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport(true));
      await page.evaluate(() => { (window as any).failControl = true; });
      await resume.click();
      await page.getByText("이어받기를 요청하지 못했습니다. 다시 시도해 주세요.", { exact: true }).waitFor();
      expect(await resume.isEnabled()).toBe(true);
      await page.evaluate(() => { (window as any).failControl = false; });
      await resume.click();
      expect(await resume.isDisabled()).toBe(true);
      expect(await page.evaluate(() => (window as any).testState.controls.filter((value: string) => value.startsWith("request-file-resume")))).toEqual(["request-file-resume resume-ui"]);
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk(1));
      await page.getByText("수신 완료 · 저장 대기", { exact: true }).waitFor();
      expect(await resume.count()).toBe(0);
      const ready = page.waitForEvent("download");
      await page.getByRole("button", { name: "받은 파일 저장", exact: true }).click();
      expect(readFileSync((await (await ready).path())!)).toEqual(bytes);
    } finally { await page.close(); }
  });
  it.each([{ width: 390, height: 844 }, { width: 844, height: 390 }])("shows mobile connection state without opening tools at $width x $height", async viewport => {
    const page = await openViewer({ connected: true, mobile: true });
    try {
      await page.setViewportSize(viewport);
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      const status = page.getByTestId("mobile-connection-status");
      await status.getByText("화면 수신 대기", { exact: true }).waitFor();
      const bounds = await status.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.evaluate(() => {
        const source = document.createElement("canvas"); source.width = 64; source.height = 32;
        const ctx = source.getContext("2d")!; ctx.fillStyle = "#28434a"; ctx.fillRect(0, 0, 64, 32);
        (window as any).rtcCallbacks.onFrame({ keyframe: true, width: 64, height: 32, tiles: [{ x: 0, y: 0, w: 64, h: 32, data: source.toDataURL("image/jpeg").split(",")[1] }] });
      });
      await status.getByText("화면 수신 중", { exact: true }).waitFor();
      await page.clock.fastForward(60_000);
      expect(await status.getByText("화면 수신 중", { exact: true }).isVisible()).toBe(true);
      await page.evaluate(() => (window as any).rtcCallbacks.onFrame({ keyframe: true, width: 64, height: 32, tiles: [{ x: 0, y: 0, w: 64, h: 32, data: "invalid" }] }));
      await status.getByText("화면 표시 오류", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error("Disconnected")));
      await status.getByText("연결 끊김", { exact: true }).waitFor();
      await page.screenshot({ path: `.local-run/mobile-connection-${viewport.width}.png` });
      expect(await page.getByRole("button", { name: "키보드", exact: true }).isVisible()).toBe(true);
    } finally { await page.close(); }
  });
  it("reports a picture only after image decoding and resets on reconnect", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 대기", { exact: true }).waitFor();
      await page.evaluate(() => {
        const source = document.createElement("canvas");
        source.width = source.height = 32;
        const ctx = source.getContext("2d")!;
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, 0, 32, 32);
        (window as any).rtcCallbacks.onFrame({ width: 32, height: 32, tiles: [{ x: 0, y: 0, w: 32, h: 32, data: source.toDataURL("image/jpeg").split(",")[1] }] });
      });
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      expect(await page.locator(".remote-canvas").evaluate((element) => (element as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data[0])).toBeGreaterThan(240);
      await page.evaluate(() => {
        const canvas=document.querySelector('.remote-canvas') as HTMLCanvasElement;
        (window as any).rtcCallbacks.onFrame({width:64,height:32,tiles:[{x:0,y:0,w:32,h:32,data:canvas.toDataURL('image/jpeg').split(',')[1]}]});
      });
      await page.clock.runFor(100);
      expect(await page.locator('.remote-canvas').evaluate(element=>(element as HTMLCanvasElement).width)).toBe(32);
      await page.getByText('Store · 화면 표시 오류',{exact:true}).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onFrame({keyframe:true,width:32,height:32,tiles:[{x:0,y:0,w:32,h:32,data:'not-a-jpeg'}]}));
      await page.getByText("Store · 화면 표시 오류", {exact:true}).waitFor();
      expect(await page.locator(".remote-canvas").evaluate(element => (element as HTMLCanvasElement).getContext("2d")!.getImageData(0,0,1,1).data[0])).toBeGreaterThan(240);
      expect(await page.getByRole("button", {name:"원격 연결 새로고침",exact:true}).isEnabled()).toBe(true);
      await page.evaluate(() => {
        const source=document.createElement('canvas'); source.width=source.height=32;
        const ctx=source.getContext('2d')!; ctx.fillStyle='#00ff00';ctx.fillRect(0,0,32,32);
        (window as any).rtcCallbacks.onFrame({keyframe:true,width:32,height:32,tiles:[{x:0,y:0,w:32,h:32,data:source.toDataURL('image/jpeg').split(',')[1]}]});
      });
      await page.getByText("Store · 화면 수신 중",{exact:true}).waitFor();
      expect(await page.locator(".remote-canvas").evaluate(element => (element as HTMLCanvasElement).getContext("2d")!.getImageData(0,0,1,1).data[1])).toBeGreaterThan(240);
      await page.evaluate(() => (window as any).rtcCallbacks.onFrame({width:32,height:32,tiles:[{x:0,y:0,w:32,h:32,data:'bad-delta'}]}));
      await page.getByText("Store · 화면 표시 오류",{exact:true}).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error("Disconnected")));
      await page.getByText("Store · 연결 끊김", { exact: true }).waitFor();
      await page.getByRole("dialog", { name: "원격 연결 끊김" }).getByRole("button", { name: "재접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 대기", { exact: true }).waitFor();
    } finally { await page.close(); }
  });
  it("requires a complete initial or resized picture while preserving incremental updates", async () => {
    const page = await openViewer({ connected: true });
    const send = async (width: number, tileWidth: number, color: string, x = 0) => {
      await page.evaluate(({ width, tileWidth, color, x }) => {
        const tile = document.createElement("canvas"); tile.width = tileWidth; tile.height = 32;
        const ctx = tile.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, tileWidth, 32);
        (window as any).rtcCallbacks.onFrame({ width, height: 32, tiles: [{ x, y: 0, w: tileWidth, h: 32, data: tile.toDataURL("image/jpeg").split(",")[1] }] });
      }, { width, tileWidth, color, x });
    };
    const pixel = (x: number, channel: number) => page.locator(".remote-canvas").evaluate((element, { x, channel }) =>
      (element as HTMLCanvasElement).getContext("2d")!.getImageData(x, 0, 1, 1).data[channel], { x, channel });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 대기", { exact: true }).waitFor();
      await send(64, 32, "#ff0000");
      await page.getByText("Store · 화면 표시 오류", { exact: true }).waitFor();
      expect(await page.locator(".device-recent-connection").count()).toBe(0);
      await send(64, 64, "#ff0000");
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      expect(await pixel(63, 0)).toBeGreaterThan(240);
      await send(64, 32, "#0000ff", 1);
      await expect.poll(() => pixel(63, 2)).toBeGreaterThan(240);
      expect(await pixel(0, 0)).toBeGreaterThan(240);
      await send(96, 32, "#00ff00");
      await page.getByText("Store · 화면 표시 오류", { exact: true }).waitFor();
      expect(await page.locator(".remote-canvas").evaluate(element => (element as HTMLCanvasElement).width)).toBe(64);
      expect(await pixel(63, 2)).toBeGreaterThan(240);
      await page.evaluate(() => {
        const NativeImage = window.Image;
        (window as any).Image = function () {
          window.Image = NativeImage;
          const img = new NativeImage();
          Object.defineProperty(img, "onload", { set(callback) {
            img.addEventListener("load", () => { (window as any).resumeOldDelta = () => callback.call(img, new Event("load")); }, { once: true });
          } });
          return img;
        };
      });
      await send(64, 32, "#ff0000");
      await page.waitForFunction(() => typeof (window as any).resumeOldDelta === "function");
      await send(96, 96, "#00ff00");
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      expect(await page.locator(".remote-canvas").evaluate(element => (element as HTMLCanvasElement).width)).toBe(96);
      expect(await pixel(95, 1)).toBeGreaterThan(240);
      await page.evaluate(() => (window as any).resumeOldDelta());
      expect(await pixel(0, 1)).toBeGreaterThan(240);
    } finally { await page.close(); }
  });
  it("records recent connection only after a real picture and retains it on the device list", async () => {
    const page = await openViewer({ connected: true });
    try {
      const row = page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) });
      await row.getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 대기", { exact: true }).waitFor();
      expect(await page.locator(".device-recent-connection").count()).toBe(0);
      await page.evaluate(() => (window as any).rtcCallbacks.onFrame({ keyframe: true, width: 32, height: 32, tiles: [{ x: 0, y: 0, w: 32, h: 32, data: "invalid" }] }));
      await page.getByText("Store · 화면 표시 오류", { exact: true }).waitFor();
      expect(await page.locator(".device-recent-connection").count()).toBe(0);
      await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
        canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
        (window as any).rtcCallbacks.onFrame({ keyframe: true, width: 32, height: 32, tiles: [{ x: 0, y: 0, w: 32, h: 32, data: canvas.toDataURL("image/jpeg").split(",")[1] }] });
      });
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      await page.getByRole("button", { name: "장비 목록", exact: true }).click();
      await row.locator(".device-recent-connection time").waitFor();
      const recorded = await row.locator(".device-recent-connection time").getAttribute("datetime");
      expect(Number.isFinite(Date.parse(recorded!))).toBe(true);
      await refresh(page).click();
      await page.waitForFunction(() => !(document.querySelector('[aria-label="장비 목록 새로고침"]') as HTMLButtonElement)?.disabled);
      expect(await row.locator(".device-recent-connection time").getAttribute("datetime")).toBe(recorded);
      await page.clock.runFor(1000);
      await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
        canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
        (window as any).rtcCallbacks.onFrame({ keyframe: true, width: 32, height: 32, tiles: [{ x: 0, y: 0, w: 32, h: 32, data: canvas.toDataURL("image/jpeg").split(",")[1] }] });
      });
      await page.clock.runFor(100);
      expect(await row.locator(".device-recent-connection time").getAttribute("datetime")).toBe(recorded);
      const older = new Date(Date.parse(recorded!) - 60_000).toISOString();
      const newer = new Date(Date.parse(recorded!) + 60_000).toISOString();
      await page.evaluate(({ older, newer }) => {
        (window as any).historyFixture = [
          { id: "older", deviceId: "device-0", status: "success", startedAt: older },
          { id: "rejected", deviceId: "device-0", status: "rejected", startedAt: newer },
        ];
      }, { older, newer });
      await page.getByRole("button", { name: "연결 이력 새로고침", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.historyReads === 1);
      await page.clock.runFor(100);
      expect(await row.locator(".device-recent-connection time").getAttribute("datetime")).toBe(recorded);
      await page.evaluate(newer => {
        (window as any).historyFixture = [...(window as any).historyFixture, { id: "newer", deviceId: "device-0", status: "closed", startedAt: newer }];
      }, newer);
      await page.getByRole("button", { name: "연결 이력 새로고침", exact: true }).click();
      await expect.poll(() => row.locator(".device-recent-connection time").getAttribute("datetime")).toBe(newer);
      expect(await page.evaluate(() => (window as any).testState.historyReads)).toBe(2);
      await page.evaluate(() => (window as any).authChanged(false));
      await row.waitFor({ state: "detached" });
      await page.evaluate(() => (window as any).authChanged(true));
      await row.waitFor();
      expect(await row.locator(".device-recent-connection").count()).toBe(0);
    } finally { await page.close(); }
  });
  it("loads devices once after authentication while history and later refreshes stay manual", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => { (window as any).authChanged(true); (window as any).authChanged(true); });
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      expect(await page.evaluate(() => [(window as any).testState.historyReads, (window as any).testState.historySubscriptions])).toEqual([0, 0]);
      await page.getByRole("button", { name: "연결 이력 새로고침", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.historyReads === 1);
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      expect(await page.evaluate(() => (window as any).testState.historyReads)).toBe(1);
      await refresh(page).click();
      await page.waitForFunction(() => (window as any).testState.reads === 2);
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("opens a fresh session from the loss dialog without list refresh or idle takeover loops", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts === 1);
      await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error("Disconnected")));
      await page.clock.fastForward(86_400_000);
      expect(await page.evaluate(() => (window as any).testState.rtcStarts)).toBe(1);
      const reads = await page.evaluate(() => (window as any).testState.reads);
      await page.getByRole("dialog", { name: "원격 연결 끊김" }).getByRole("button", { name: "재접속", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts === 2);
      expect(await page.evaluate(() => (window as any).testState.connections)).toEqual(["device-0", "device-0"]);
      expect(await page.evaluate(() => (window as any).testState.closedSessions)).toEqual(["remote-session-device-0-1"]);
      expect(await page.evaluate(() => (window as any).testState.reads)).toBe(reads);
    } finally { await page.close(); }
  });
  it("does not poll unused session features, keeps one subscription through rerenders and closes it on exit", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByRole("button", { name: "세션 종료", exact: true }).waitFor();
      await page.clock.fastForward(86_400_000);
      const stats = await page.evaluate(() => {
        const s = (window as any).testState;
        return { reads: s.auxiliaryReads, count: s.auxiliarySubscriptions.length, options: s.auxiliarySubscriptions[0]?.options };
      });
      expect(stats.reads).toBe(0); expect(stats.count).toBe(1);
      expect(stats.options.clipboard).toBe(false); expect(stats.options.receiptIds ?? []).toHaveLength(0);
      await page.getByRole("button", { name: "세션 종료", exact: true }).click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await page.evaluate(() => (window as any).testState.auxiliaryStops)).toBe(1);
    } finally { await page.close(); }
  });
  it("loads once, remains idle for 24h and rerenders, then reads once per explicit refresh", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await page.clock.fastForward(86_400_000);
      expect(await page.locator(".table-row").filter({ has: page.getByText("PC-9", { exact: true }) }).locator(".status-pill").innerText()).toBe("온라인");
      await page.getByPlaceholder("매장, 장비, 담당자, 연락처, 메모 검색").fill("PC-0");
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      for (let i = 0; i < 10; i++) {
        await refresh(page).click();
        await page.waitForFunction((reads) => (window as any).testState.reads === reads, i + 2);
      }
      expect(await counts(page)).toEqual({ reads: 11, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("coalesces slow refresh clicks and ignores completion after logout, then reloads on login", async () => {
    const page = await openViewer({ slow: true });
    try {
      await page.waitForFunction(() => (window as any).testState.reads === 1);
      for (let i = 0; i < 5; i++) await refresh(page).dispatchEvent("click");
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await page.evaluate(() => (window as any).authChanged(false));
      await page.locator('input[name="username"]').waitFor();
      await page.evaluate(() => {
        const w = window as any; w.testState.slow = false;
        w.testState.devices[0].desktopName = "New-PC"; w.authChanged(true);
      });
      await page.getByText("New-PC", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).finishRead());
      await page.clock.fastForward(86_400_000);
      expect(await page.getByText("PC-0", { exact: true }).count()).toBe(0);
      expect(await page.getByText("New-PC", { exact: true }).count()).toBe(1);
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("does not retry quota errors until manual refresh", async () => {
    const page = await openViewer({ fail: true });
    try {
      await page.getByText("Quota exceeded.", { exact: true }).waitFor();
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await page.evaluate(() => { (window as any).testState.fail = false; });
      await refresh(page).click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("lets stale offline rows reach normal, secure and split connection checks", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      const row = page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) });
      expect(await row.getByRole("button", { name: "접속", exact: true }).isEnabled()).toBe(true);
      await row.getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Current target is offline.", { exact: true }).waitFor();
      await row.getByRole("button", { name: "보안접속", exact: true }).click();
      await page.getByRole("checkbox", { name: "PC-0 선택", exact: true }).check();
      await page.getByRole("checkbox", { name: "PC-1 선택", exact: true }).check();
      await page.getByRole("button", { name: /좌우 분할/ }).click();
      expect(await page.evaluate(() => (window as any).testState.connections)).toEqual(["device-0", "secure:device-0", "device-0", "device-1"]);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("also avoids list polling and duplicate login reads in local mode", async () => {
    const page = await openViewer({ local: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await refresh(page).click();
      await page.waitForFunction(() => (window as any).testState.reads === 2);
    } finally { await page.close(); }
  });

  it("keeps two Android Viewer sessions alive with reachable portrait and landscape controls", async () => {
    const page = await openViewer({ connected: true, mobile: true });
    const assertMobileLayout = async () => {
      const layout = await page.evaluate(() => {
        const activePanel = document.querySelector('.session-panel:not(.session-panel-inactive)')!;
        const bar = activePanel.querySelector('.mobile-remote-controls')!.getBoundingClientRect();
        const work = activePanel.querySelector('[data-testid="remote-canvas-viewport"]')!.getBoundingClientRect();
        return {
          barBottom: Math.round(bar.bottom),
          pageWidth: document.documentElement.scrollWidth,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          workHeight: Math.round(work.height),
        };
      });
      expect(layout.pageWidth).toBe(layout.viewportWidth);
      expect(Math.abs(layout.viewportHeight - layout.barBottom)).toBeLessThanOrEqual(2);
      expect(layout.workHeight).toBeGreaterThan(layout.viewportHeight * 0.45);
    };

    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await page.evaluate(() => ({
        noHorizontalOverflow: document.documentElement.scrollWidth === window.innerWidth,
        statusStaysOnOneLine: getComputedStyle(document.querySelector(".status-pill")!).whiteSpace === "nowrap",
      }))).toEqual({ noHorizontalOverflow: true, statusStaysOnOneLine: true });
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.getByTestId("remote-session-workspace").waitFor();
      await assertMobileLayout();

      const activePanel = page.locator(".session-panel:not(.session-panel-inactive)");
      await activePanel.getByRole("button", {name:"터치패드 모드", exact:true}).click();
      await activePanel.getByLabel("원격 터치패드", {exact:true}).waitFor();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!).inputMode === "touchpad");
      await activePanel.getByLabel("원격 터치패드", {exact:true}).evaluate(el => {
        (el as HTMLElement).setPointerCapture = () => {};
        (el as HTMLElement).hasPointerCapture = () => false;
        for (const type of ["pointerdown", "pointerup"]) el.dispatchEvent(new PointerEvent(type,{pointerId:1,clientX:100,clientY:100,pointerType:"touch",bubbles:true}));
      });
      await page.waitForFunction(() => JSON.stringify((window as any).testState.controls).includes("mouse-up"));
      expect(JSON.stringify(await page.evaluate(() => (window as any).testState.controls))).toContain("mouse-down");
      await activePanel.getByRole("button", { name: "화면 및 세션 설정", exact: true }).click();
      const popup = await activePanel.getByTestId("remote-command-bar").boundingBox();
      const bar = await activePanel.locator(".mobile-remote-controls").boundingBox();
      expect(popup).not.toBeNull(); expect(bar).not.toBeNull();
      expect(popup!.y + popup!.height).toBeLessThanOrEqual(bar!.y + 1);
      await page.screenshot({ path: ".local-run/mobile-tools-status-height.png" });
      await activePanel.getByRole("button", { name: "도구 닫기", exact: true }).click();

      await activePanel.getByRole("button", { name: "화면 및 세션 설정", exact: true }).click();
      await activePanel.getByRole("button", { name: "장비 목록", exact: true }).click();
      await page.getByText("열린 세션 1", { exact: true }).waitFor();
      expect(await page.evaluate(() => (window as any).testState.closedSessions)).toEqual([]);
      await page.locator(".table-row").filter({ has: page.getByText("PC-1", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();

      const tabs = page.getByRole("navigation", { name: "열린 원격 세션", exact: true });
      expect(await activePanel.getByRole("button", {name:"터치패드 모드",exact:true}).getAttribute("aria-pressed")).toBe("false");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!).inputMode)).toBe("touchpad");
      await tabs.getByRole("button", { name: "PC-0", exact: true }).click();
      const activeConnection = page.locator('.session-panel:not(.session-panel-inactive) [data-testid="remote-connection-status"]');
      expect(await activeConnection.innerText()).toContain("PC-0");
      expect(await page.evaluate(() => ({
        connections: (window as any).testState.connections,
        reads: (window as any).testState.reads,
        rtcStarts: (window as any).testState.rtcStarts,
      }))).toEqual({ connections: ["device-0", "device-1"], reads: 1, rtcStarts: 2 });

      await page.setViewportSize({ width: 844, height: 390 });
      await assertMobileLayout();
      await tabs.getByRole("button", { name: "PC-1 세션 닫기", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.closedSessions.length === 1);
      expect(await page.evaluate(() => (window as any).testState.closedSessions)).toEqual(["remote-session-device-1-2"]);
      expect(await activeConnection.innerText()).toContain("PC-0");
    } finally { await page.close(); }
  });
});
