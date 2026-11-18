import { readFileSync } from "node:fs";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ManagedDevice } from "./domain/types";
import type { AgentWebRtcTransport } from "./firebase/agentFirebase";

const localFirebaseServices = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./firebase/firebaseServices", () => ({
  getWonRemoteFirebaseServices: ({appId}: {appId?:string}) => {
    const services = localFirebaseServices.get(appId ?? "");
    if (!services) throw new Error("Expected an initialized loopback timing fixture.");
    return services;
  },
}));
const localPeerFactory = vi.hoisted(() => ({
  create: undefined as typeof import("./firebase/agentPeerConnection").createAgentPeerConnection | undefined,
}));
vi.mock("./firebase/agentPeerConnection", async original => ({
  ...await original<typeof import("./firebase/agentPeerConnection")>(),
  createAgentPeerConnection: (config: Parameters<typeof import("./firebase/agentPeerConnection").createAgentPeerConnection>[0]) => {
    if (!localPeerFactory.create) throw new Error("Expected an isolated loopback peer factory.");
    return localPeerFactory.create(config);
  },
}));

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { App } from "./src/App"; import { collectDevicePresence } from "./src/domain/devicePresenceRefresh"; import { markConnectionTiming } from "./src/domain/connectionTiming"; window.testMarkConnectionTiming = markConnectionTiming; window.collectDevicePresence = collectDevicePresence; window.root = createRoot(document.getElementById("root")); window.root.render(<React.StrictMode><App /></React.StrictMode>);',
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, outfile: "viewer-test.js", platform: "browser", format: "iife",
    loader: { ".png": "dataurl" },
    define: { "import.meta.env": "window.testEnv", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "offline-firebase-boundary", setup(builder) {
      builder.onLoad({ filter: /[\\/]src[\\/]App\.tsx$/ }, ({ path }) => {
        const code = readFileSync(path, "utf8");
        const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const panel = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "RemoteSessionPanel");
        if (!panel?.body) throw new Error("Cannot instrument RemoteSessionPanel render in browser tests.");
        const start = panel.body.getStart(source) + 1;
        const instrumented = code.slice(0, start) + "\nwindow.testSessionPanelRenders = (window.testSessionPanelRenders ?? 0) + 1;\n" + code.slice(start);
        return {
          contents: instrumented.replace(/\b(setPicturePresented|setRemoteCursorEmbedded)\(/g,
            "(window.testPictureStateDispatch?.('$1'), $1)("),
          loader: "tsx",
        };
      });
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

async function openViewer(options: { authenticated?: boolean; firstRun?: boolean; agent?: boolean; manual?: boolean; slow?: boolean; fail?: boolean; local?: boolean; connected?: boolean; mobile?: boolean; emulateMobile?: boolean; rolloutSupported?: boolean; nativeAndroid?: boolean; desktop?: boolean; accountManager?: boolean; diagnosticTiles?: boolean; viewport?: { width: number; height: number }; storeName?: string; firestorePort?: number; firestoreGroupingProject?: string } = {}, liveClockBrowser?: Browser, beforeMount?: (page: Page) => Promise<void>) {
  const page = await (liveClockBrowser ?? browser).newPage({ viewport: options.viewport ?? (options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }), ...(options.emulateMobile ? { isMobile: true, hasTouch: true } : {}), ...(options.nativeAndroid ? { userAgent: "Android WonRemoteViewer/1" } : {}) });
  const origin = options.firestorePort ? `http://127.0.0.1:${options.firestorePort}`
    : options.nativeAndroid ? "https://wonremote-a7fd3.web.app" : "http://viewer.test";
  page.setDefaultTimeout(3_000);
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${origin}/${options.mobile ? "viewer" : ""}`) return route.fulfill({
      contentType:"text/html", headers:options.firestorePort ? {"Content-Security-Policy":"connect-src 'self'"} : {},
      body:'<meta name="viewport" content="width=device-width, initial-scale=1.0"><div id="root"></div>',
    });
    if (options.firestorePort && url.startsWith(`${origin}/google.firestore.v1.Firestore/`)) return route.continue();
    if (options.firestorePort && options.firestoreGroupingProject) {
      const rpc = `${origin}/v1/projects/${options.firestoreGroupingProject}/databases/(default)/documents:`;
      if (url.startsWith(rpc) && /^(batchGet|commit)(?:\?|$)/.test(url.slice(rpc.length))) return route.continue();
    }
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
  if (!liveClockBrowser) await page.clock.install();
  await page.evaluate((opts) => {
    const w = window as any;
    w.testEnv = opts.diagnosticTiles ? {VITE_WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK:"diagnostic"} : {};
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
          if (command === "get_app_mode") return opts.agent ? "agent" : "viewer";
          if (command === "get_login_input_state") {
            if(w.deferInputState)return new Promise(resolve=>{w.finishInputState=resolve;});
            return w.loginInputState ?? {capsLock:false,inputMode:"en"};
          }
          if (command === "get_agent_config") return opts.firstRun ? null : w.agentConfig ?? {businessNumber:"123-45-67890",registeredDeviceId:"123-45-67890:AGENT-0",installId:"test-agent"};
          if (command === "load_zook_number") return w.zookNumber ?? (opts.agent && !opts.firstRun ? "00123456" : "");
          if (command === "configure_zook_agent") {
            await new Promise<void>(resolve => { w.finishZook = resolve; });
            if (w.zookFailure) throw w.zookFailure;
            w.zookNumber = args.number;
            return `014-${args.number.slice(0,4)}-${args.number.slice(4)}`;
          }
          if (command === "get_or_create_agent_install_id") return "test-agent";
          if (command === "get_computer_name") return "PC";
          if (command === "begin_viewer_download") return "local-save";
          if (command === "write_viewer_download") { w.nativeChunks.push(args.data); return; }
          if (command === "finish_viewer_download") {
            if (w.holdNativeSave) await new Promise<void>(resolve => { w.releaseNativeSave = resolve; });
            if (w.failNativeSave) throw Error("Disk full");
            return "C:/Downloads/received.txt";
          }
          if (command === "choose_viewer_download_folder") return "C:/Downloads";
          if (command === "check_selected_viewer_update") return {available:Boolean(w.selectedUpdateAvailable)};
          return 1;
        },
      };
    }
    const state = w.testState = {
      reads: 0, subscriptions: 0, connections: [] as string[], closedSessions: [] as string[], slow: Boolean(opts.slow), fail: Boolean(opts.fail),
      presenceCommands: [] as string[], presenceStarts: 0, presenceStops: 0, refreshTargets: [] as unknown[],
      auxiliaryReads: 0, auxiliarySubscriptions: [] as any[], auxiliaryStops: 0,
      groupingStarts: 0, groupingStops: 0,
      historyReads: 0, historySubscriptions: 0, rtcStarts: 0, controls: [] as unknown[],
      devices: Array.from({ length: 10 }, (_, i) => ({
        id: `device-${i}`, deviceNumber: `AGENT-${i}`, businessNumber: "123-45-67890",
        desktopName: `PC-${i}`, deviceName: "POS", storeName: opts.storeName ?? "Store", status: i === 9 ? "online" : "offline", protocolVersion: 1,
        lastSeenAt: new Date().toISOString(),
        ...(opts.manual ? { presenceMode: "manual" } : {}),
        ...(opts.rolloutSupported ? {version:"0.1.93",selectedRolloutVersion:"0.1.93",rollbackSupportVersion:"0.1.93"} : {}),
      })),
    };
    w.groupingDocs ??= {};
    w.groupingListeners = new Map();
    w.testApi = new Proxy({
      isViewerFirebaseEnabled: () => !opts.local,
      subscribeViewerAuthState: (next: (authenticated: boolean, uid?: string) => void) => {
        w.authChanged = next; next(opts.authenticated !== false, "viewer-1"); return () => {};
      },
      subscribeViewerGrouping: (uid: string, next: (grouping: unknown) => void, fail: (error: Error) => void) => {
        state.groupingStarts++;
        w.groupingListeners.set(uid, next);
        if (w.rejectGrouping) fail(Object.assign(new Error("Missing permissions"), {code:"permission-denied"}));
        else if (!w.holdGrouping) next(structuredClone(w.groupingDocs[uid] ?? {customGroups: [], groupOrder: []}));
        return () => { state.groupingStops++; w.groupingListeners.delete(uid); };
      },
      saveViewerGrouping: async (uid: string, change: (grouping: unknown) => unknown) => {
        w.groupingDocs[uid]=change(structuredClone(w.groupingDocs[uid] ?? {customGroups: [], groupOrder: []}));
        w.groupingListeners.get(uid)?.(structuredClone(w.groupingDocs[uid]));
      },
      subscribeFirebaseDevices: (next: (devices: unknown[]) => void) => {
        state.subscriptions++; next(structuredClone(state.devices)); return () => {};
      },
      subscribeFirebaseConnectionHistory: (next: (history: unknown[]) => void) => { state.historySubscriptions++; next([]); return () => {}; },
      fetchFirebaseConnectionHistory: async () => { state.historyReads++; return w.historyFixture ?? []; },
      isCurrentViewerAccountManager: async () => Boolean(opts.accountManager),
      fetchFirebaseDevices: async (_env?: unknown, refreshPresence = false, signal?: AbortSignal, onProgress?: (devices: unknown[], pendingIds: string[]) => void, knownDevices?: unknown[], targetDeviceIds?: string[]) => {
        state.reads++;
        state.refreshTargets.push(targetDeviceIds ?? null);
        const devices = structuredClone(state.devices).filter((device:any)=>targetDeviceIds===undefined||targetDeviceIds.includes(device.id));
        if (refreshPresence && w.parallelRefresh) {
          const read = new Promise(resolve => { w.finishParallelRead = () => resolve(structuredClone(state.devices)); });
          state.presenceCommands = []; state.presenceStarts = 0; state.presenceStops = 0;
          return w.collectDevicePresence(knownDevices ?? [], "nonce", (next: any) => {
            state.presenceStarts++;
            w.replyParallel = (id: string) => next({ ...state.devices.find((device: any) => device.id === id), heartbeatRequestId: "nonce", status: "online" });
            return () => { state.presenceStops++; };
          }, async (device: any) => { state.presenceCommands.push(device.id); }, signal, onProgress, read);
        }
        if (refreshPresence && w.refreshProgressAllOnline) {
          const fresh = devices.map((device: any) => ({ ...device, desktopName: `Fresh-${device.desktopName}`, presenceMode: "manual", status: "online" }));
          onProgress?.(fresh, fresh.map((device: any) => device.id));
          w.emitPresenceReply = () => onProgress?.(fresh, fresh.slice(1).map((device: any) => device.id));
          await new Promise<void>((resolve) => { w.finishPresenceRefresh = resolve; });
          delete w.finishPresenceRefresh;
          delete w.emitPresenceReply;
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
      queuePreparedFirebaseViewerOffer: () => {},
      startFirebaseViewerWebRtcTransport: async (_id: string, callbacks: any) => {
        state.rtcStarts++; w.rtcCallbacks = callbacks;
        if (callbacks.startInFastMode) state.controls.push("set-stream-mode fast");
        callbacks.onState("webrtc-open");
        return { close: () => {}, isControlReady: () => true, sendControl: (value: unknown) => { if (w.failControl) return false; state.controls.push(value); return true; }, sendFile: async (input:unknown) => w.testSendFile ? w.testSendFile(input) : false };
      },
      fetchFirebaseTiles: async () => {
        const frame = w.nextDiagnosticFrame;
        w.nextDiagnosticFrame = null;
        return frame ?? {tiles:[],width:0,height:0};
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
      requestFirebaseAgentUpdate: async (id:string,requestId:string) => { (w.updateRequests??=[]).push({id,requestId}); },
      subscribeFirebaseAgentUpdate: (id:string,next:any,fail:any) => {
        (w.updateWatchers??={})[id]={next,fail};(w.updateWatchStarts??=[]).push(id);
        return()=>{(w.updateWatchStops??=[]).push(id);delete w.updateWatchers[id];};
      },
    }, { get(target, key) { return (target as any)[key] ?? (async () => null); } });
  }, options);
  await beforeMount?.(page);
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
  const admissionCases = [{ realInventory: false, locked: false }, { realInventory: true, locked: false }];
  if (process.platform === "win32") admissionCases.push({ realInventory: true, locked: true });
  it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST).each(admissionCases)("measures first picture through actual admission, Agent command and Firestore signaling (inventory: $realInventory, locked: $locked)", async ({ realInventory, locked }) => {
    const address = process.env.FIRESTORE_EMULATOR_HOST!;
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Expected a loopback Firestore emulator.");
    const port = Number(address.split(":")[1]);
    const { initializeApp, deleteApp } = await import("firebase/app");
    const { getFirestore, connectFirestoreEmulator, doc, getDocFromServer, collection, getDocsFromServer, query, where, setDoc, serverTimestamp } = await import("firebase/firestore");
    const { subscribeAgentCommandsWithFirebase, startAgentWebRtcTransportWithFirebase, isAgentDeviceAccessSessionAllowed, processAgentDeviceAccessRequest } = await import("./firebase/agentFirebase");
    const { createLoopbackAgentPeers, wireBrowserToLocalFirestore, loopbackStun } = await import("./firebase/browserFirestoreRtcFixture");
    const projectId = `demo-connect-${crypto.randomUUID().slice(0,8)}`, deviceId = "device-0";
    const agentUid = "connect-agent", viewerUid = "connect-viewer", installId = "connect-install";
    const app = initializeApp({projectId,apiKey:"loopback-only"},"loopback-connection-agent");
    const agentDb = getFirestore(app);
    connectFirestoreEmulator(agentDb,"127.0.0.1",port,{mockUserToken:{sub:agentUid,wonremoteViewer:false}});
    localFirebaseServices.set(agentUid,{db:agentDb,auth:{currentUser:{uid:agentUid}}});
    const env = {VITE_WONREMOTE_FIREBASE_PROJECT_ID:projectId,VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN:"localhost",
      VITE_WONREMOTE_FIREBASE_API_KEY:"loopback-only",VITE_WONREMOTE_FIREBASE_APP_ID:agentUid,VITE_WONREMOTE_RTC_STUN_URLS:loopbackStun};
    const {peers,create} = createLoopbackAgentPeers();
    localPeerFactory.create = create;
    const transports = new Map<string,AgentWebRtcTransport>();
    const starts:string[] = [], stops:string[] = [], errors:string[] = [], controls:string[] = [];
    const approvalsMs: number[] = [], verificationMs: number[] = [];
    const agentStartup: {admission:number; admittedToOffer:number; offerToOpen:number}[] = [];
    let unsubscribe: (()=>void) | undefined, wireBrowser: Browser | undefined;
    let commandWork: Promise<void> | undefined;
    let lockDirectory: string | undefined;
    let lock: import("./agent/deviceAccessLock").AgentDeviceAccessLock | null = null;
    const password = locked ? crypto.randomUUID() : "";
    try {
      if (locked) {
        const { AgentDeviceAccessLock } = await import("./agent/deviceAccessLock");
        const { encryptDeviceAccessRequest } = await import("./domain/deviceAccessLock");
        lockDirectory = await mkdtemp(join(tmpdir(), "wonremote-locked-loopback-"));
        lock = await AgentDeviceAccessLock.load(join(lockDirectory, "lock.dat"), deviceId);
        const setup = await encryptDeviceAccessRequest({ id: crypto.randomUUID(), deviceId, ownerUid: viewerUid,
          operation: "set", sessionId: "", lockVersion: "" }, lock.publicState.publicKey, {password:"",newPassword:password});
        await lock.authorize(setup);
        const authorize = lock.authorize.bind(lock);
        vi.spyOn(lock, "authorize").mockImplementation(async (request, now, publish) => {
          const start = performance.now();
          return authorize(request, now, async state => {
            verificationMs.push(Math.round(performance.now() - start));
            await publish?.(state);
          });
        });
      }
      const registration = {ownerUid:agentUid,installId,status:"online",
        businessNumber:"123-45-67890",deviceNumber:"AGENT-CONNECT",desktopName:realInventory?"Server-PC":"PC-0",deviceName:"POS",storeName:"Store",
        protocolVersion:2,lastSeenAtServer:serverTimestamp(),
        ...(lock ? {accessLocked:true,accessLockVersion:lock.publicState.version,accessPublicKey:lock.publicState.publicKey} : {})};
      await expect(setDoc(doc(agentDb,"devices","different-owner"),{...registration,ownerUid:"wrong-owner"}))
        .rejects.toMatchObject({code:"permission-denied"});
      await setDoc(doc(agentDb,"devices",deviceId),registration);
      if (lock) await setDoc(doc(agentDb,"deviceAccessLocks",deviceId),{enabled:true,version:lock.publicState.version,updatedAt:serverTimestamp()});
      wireBrowser = await chromium.launch({headless:true,args:["--allow-loopback-in-peer-connection","--disable-features=WebRtcHideLocalIpsWithMdns"]});
      const wire = (page: Page) => wireBrowserToLocalFirestore(page,projectId,viewerUid,port,realInventory);
      let firestoreRequests = 0;
      const page = await openViewer({firestorePort:port},wireBrowser,async page => {
        page.on("request", request => {
          if (request.url().startsWith(`http://127.0.0.1:${port}/google.firestore.v1.Firestore/`)) firestoreRequests++;
        });
        if (realInventory) await wire(page);
      });
      await page.route("**/fixture-redirect-probe",route=>route.fulfill({
        status:302,headers:{location:`http://127.0.0.1:${port===65521?65522:65521}/different-origin`},
      }));
      const blocked = await page.evaluate(async ()=>{
        const observed = new Promise<string>(resolve => document.addEventListener("securitypolicyviolation",
          event=>resolve(event.effectiveDirective),{once:true}));
        await fetch("/fixture-redirect-probe",{signal:AbortSignal.timeout(1_000)}).catch(()=>{});
        return Promise.race([observed,new Promise(resolve=>setTimeout(()=>resolve("no CSP violation"),1_000))]);
      });
      expect(blocked).toBe("connect-src");
      const palettes = [[[239,40,64],[18,99,218]],[[34,173,87],[234,116,46]],[[87,57,173],[44,180,176]]];
      const frames = await page.evaluate(palettes => palettes.map(([left,right]) => {
        const width=1920, height=1080, tiles=[];
        const source=document.createElement("canvas");
        for (let y=0;y<height;y+=128) for (let x=0;x<width;x+=128) {
          const w=Math.min(128,width-x), h=Math.min(128,height-y);
          source.width=w; source.height=h;
          const ctx=source.getContext("2d")!;
          ctx.fillStyle=`rgb(${(x<960?left:right).join(",")})`;ctx.fillRect(0,0,w,h);
          tiles.push({x:x/32,y:y/32,w,h,data:source.toDataURL("image/jpeg").split(",")[1]});
        }
        return {width,height,tiles,sequence:1,keyframe:true};
      }),palettes);
      if (!realInventory) await wire(page);
      let ready=false;
      unsubscribe = await subscribeAgentCommandsWithFirebase({deviceId,installId,onReady:()=>{ready=true;}},commands => commandWork=(async()=>{
        for (const {action} of commands) {
          const [kind,id] = action.split(" ");
          if (kind === "device-access" && id && lock) {
            const start = performance.now();
            await processAgentDeviceAccessRequest(deviceId,id,lock,async () => { throw new Error("Unexpected lock mutation"); },env);
            approvalsMs.push(Math.round(performance.now() - start));
          } else if (kind === "start-stream" && id) {
            const start = performance.now();
            if (!await isAgentDeviceAccessSessionAllowed(deviceId,id,lock,env)) throw new Error("Fixture session access denied.");
            const admitted = performance.now();
            const metrics = {admission:Math.round(admitted - start),admittedToOffer:-1,offerToOpen:-1};
            agentStartup.push(metrics);
            let offerAt: number | undefined;
            const frame=frames[starts.length];
            if(!frame) throw new Error("Unexpected additional capture.");
            starts.push(id);
            let open=false, sent=false, transport:AgentWebRtcTransport | undefined;
            const trySend=()=>{
              if (!open || !transport || sent) return;
              sent=transport.sendFrame(frame)==="sent";
              if (!sent) errors.push("First frame could not be sent.");
            };
            transport=await startAgentWebRtcTransportWithFirebase(id,{
              onState:(state,error)=>{
                if(state==="negotiating" && offerAt === undefined){
                  offerAt = performance.now();
                  metrics.admittedToOffer = Math.round(offerAt - admitted);
                }
                if(state==="open"){
                  if (offerAt !== undefined) metrics.offerToOpen = Math.round(performance.now() - offerAt);
                  open=true;trySend();
                }
                if(state==="error")errors.push(error??"Agent WebRTC failed.");
              },
              onControl:(control,current)=>{if(current()) controls.push(control);},
            },env);
            transports.set(id,transport);
            trySend();
          } else if (kind === "stop-stream" && id) {
            await transports.get(id)?.close();
            transports.delete(id); stops.push(id);
          } else throw new Error("Unexpected loopback session command.");
        }
      })(),error=>errors.push(error.message),env);
      await vi.waitFor(()=>expect(ready).toBe(true),{timeout:3_000});
      await page.evaluate(()=>{
        const realInfo=console.info.bind(console), reports:unknown[]=[];
        (window as any).connectionPixelReports=reports;
        (window as any).offerTimingBeforePanel=[];
        console.info=(message,...args)=>{
          const prefix="[ConnectionTiming] ";
          if(typeof message==="string"&&message.startsWith(prefix)){
            const {stage,attempt}=JSON.parse(message.slice(prefix.length));
            if(stage==="offer-queued"){
              (window as any).offerTimingBeforePanel.push(!document.querySelector(".session-panel"));
            }
            if(stage==="first-picture"){
              const canvas=document.querySelector<HTMLCanvasElement>(".session-panel:not(.session-panel-inactive) .remote-canvas");
              const ctx=canvas?.getContext("2d");
              reports.push({attempt,size:[canvas?.width,canvas?.height],
                visible:Boolean(canvas?.getClientRects().length && document.visibilityState==="visible"),
                pixels:ctx?[[1,1],[1918,1078]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3)):[]});
            }
          }
          realInfo(message,...args);
        };
      });
      const timeline:{stage:string;attempt:number;elapsedMs:number}[] = [];
      page.on("console",message=>{
        const prefix="[ConnectionTiming] ";
        if(message.text().startsWith(prefix)) timeline.push(JSON.parse(message.text().slice(prefix.length)));
      });
      const row=page.locator(".table-row").filter({has:page.getByText(registration.desktopName,{exact:true})});
      await row.waitFor();
      if (realInventory) expect(await counts(page)).toEqual({reads:0,subscriptions:0});
      expect(firestoreRequests > 0).toBe(realInventory);
      const canvas=page.locator(".remote-canvas");
      for(let attempt=1;attempt<=3;attempt++){
        await row.getByRole("button",{name:"접속",exact:true}).click();
        if (locked && attempt === 1) {
          const dialog = page.getByRole("dialog", {name:"잠금 장비 접속"});
          await dialog.getByLabel("접속 비밀번호").fill(password);
          await dialog.getByRole("button",{name:"접속",exact:true}).click();
        }
        await expect.poll(()=>({errors,starts:starts.length,pictures:timeline.filter(event=>event.stage==="first-picture").length}),
          {timeout:7_000}).toEqual({errors:[],starts:attempt,pictures:attempt});
        const pixels=await page.evaluate(index=>(window as any).connectionPixelReports[index],attempt-1);
        const picture=timeline.filter(event=>event.stage==="first-picture")[attempt-1];
        expect(pixels).toMatchObject({attempt:picture.attempt,visible:true,size:[1920,1080]});
        const screenshot=await canvas.screenshot();
        const composed=await page.evaluate(async png=>{
          const image=new Image();
          image.src=`data:image/png;base64,${png}`;
          await image.decode();
          const sample=document.createElement("canvas");
          sample.width=sample.height=1;
          const ctx=sample.getContext("2d")!;
          return [0.25,0.75].map(x=>{
            ctx.drawImage(image,Math.floor(image.width*x),Math.floor(image.height/2),1,1,0,0,1,1);
            return Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
          });
        },screenshot.toString("base64"));
        for(const actual of [pixels.pixels,composed]){
          expect(actual).toHaveLength(2);
          palettes[attempt-1].forEach((color,i)=>color.forEach((value,j)=>expect(Math.abs(value-actual[i][j])).toBeLessThan(8)));
        }
        const candidates=peers[attempt-1].iceTransports.flatMap(transport=>transport.connection.localCandidates);
        expect(candidates.map(candidate=>candidate.host)).toContain("127.0.0.1");
        expect(candidates.every(candidate=>candidate.host==="127.0.0.1")).toBe(true);
        if(attempt===1){
          const box=(await canvas.boundingBox())!;
          await page.mouse.move(box.x+box.width/4,box.y+box.height/3);
          await expect.poll(()=>controls.some(action=>action.startsWith("move "))).toBe(true);
        }
        await page.getByTestId("end-session").click();
        await expect.poll(()=>stops.length,{timeout:5_000}).toBe(attempt);
        expect((await getDocFromServer(doc(agentDb,"sessions",starts[attempt-1]))).data()?.state).toBe("closed");
      }
      expect(stops).toEqual(starts);
      expect(peers).toHaveLength(3);
      expect(agentStartup).toHaveLength(starts.length);
      for (const metrics of agentStartup) {
        for (const ms of Object.values(metrics)) expect(ms).toBeGreaterThanOrEqual(0);
      }
      for(const peer of peers){
        expect(peer.connectionState).toBe("closed");
      }
      if (locked) {
        expect(approvalsMs).toHaveLength(3);
        expect(verificationMs).toHaveLength(3);
        const earlyOffers = await page.evaluate(() => (window as any).offerTimingBeforePanel);
        expect(earlyOffers).toHaveLength(3);
        expect(earlyOffers).toContain(true);
        await expect(page.evaluate(id => (window as any).testApi.openFirebaseSession(id,undefined,false,"wrong-fixture-password"),deviceId)).rejects.toThrow("비밀번호가 일치하지 않습니다");
        const sessions = await getDocsFromServer(query(collection(agentDb,"sessions"),where("deviceId","==",deviceId)));
        expect(sessions.docs.map(session => session.id).sort()).toEqual([...starts].sort());
        expect(starts).toHaveLength(3);
        expect(peers).toHaveLength(3);
      }
      const delivered=(await getDocsFromServer(collection(agentDb,"devices",deviceId,"commands"))).docs;
      expect(delivered.filter(command=>command.data().action.startsWith("start-stream ")).map(command=>command.data().state)).toEqual(["delivered","delivered","delivered"]);
      const stages=["connect-click","connect-request","device-validated",...(locked ? ["access-request-queued","access-request-acknowledged","access-approved"] : []),
        "command-dispatched","offer-queued","frame-received","first-picture"];
      const samples=timeline.filter(event=>event.stage==="first-picture").map(picture=>{
        const attempt=timeline.filter(event=>event.attempt===picture.attempt);
        const required = Object.fromEntries(stages.map(stage=>{
          const event=attempt.find(event=>event.stage===stage);
          expect(event,`Timing stage ${stage}`).toBeDefined();
          return [stage,Math.round(event!.elapsedMs)];
        }));
        for (const stage of ["offer-sent","channel-open"]) {
          const event = attempt.find(event => event.stage === stage);
          if (event) required[stage] = event.elapsedMs;
        }
        return required;
      });
      const requestToPictureMs = samples.map(sample => sample["first-picture"] - sample["connect-request"]);
      const splits = samples.map(sample => {
        const duration = (from: string, to: string) => {
          const elapsed = sample[to] - sample[from];
          expect(elapsed, `${from} to ${to}`).toBeGreaterThanOrEqual(0);
          return elapsed;
        };
        return {
          freshDevice: duration("connect-request","device-validated"),
          ...(locked ? {
            accessQueueToAck: duration("access-request-queued","access-request-acknowledged"),
            accessAckToApproval: duration("access-request-acknowledged","access-approved"),
            approvedToSessionAck: duration("access-approved","command-dispatched"),
          } : {}),
          sessionAckToOfferQueue: duration("command-dispatched","offer-queued"),
          // A picture can finish the trace before an offer ACK or the control channel opens.
          offerQueueToAck: sample["offer-sent"] === undefined ? null : duration("offer-queued","offer-sent"),
          offerQueueToBothChannelsOpen: sample["channel-open"] === undefined ? null : duration("offer-queued","channel-open"),
          receivedToPainted: duration("frame-received","first-picture"),
        };
      });
      const iceWrites = await page.evaluate(() => (window as any).fixtureIceCounts);
      process.stdout.write(`Local connection through Firestore and WebRTC (real inventory: ${realInventory}, locked: ${locked}, ms): ${JSON.stringify({samples,requestToPictureMs,splits,agentStartup,approvalsMs:approvalsMs.slice(0,3),verificationMs,iceWrites})}\n`);
    } finally {
      unsubscribe?.();
      try {
        await commandWork?.catch(()=>{});
        await Promise.allSettled([...transports.values()].map(transport=>transport.close()));
        await Promise.allSettled(peers.map(peer=>peer.close()));
        await wireBrowser?.close();
      } finally {
        localPeerFactory.create=undefined;
        localFirebaseServices.clear();
        try { await deleteApp(app); }
        finally {
          try {
            if (lockDirectory) {
              await rm(join(lockDirectory, "lock.dat"), {force:true});
              await rmdir(lockDirectory);
            }
          } finally {
            const clear=await fetch(`http://127.0.0.1:${port}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
              {method:"DELETE",redirect:"error",signal:AbortSignal.timeout(3_000)});
            expect(clear.ok).toBe(true);
          }
        }
      }
    }
  }, 35_000);

  it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST).each([false,true])("measures a searched refresh through an Agent heartbeat and visible rows (grouped: %s)", async grouped => {
    const address = process.env.FIRESTORE_EMULATOR_HOST!;
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Expected a loopback Firestore emulator.");
    const {initializeApp, deleteApp} = await import("firebase/app");
    const {getFirestore, connectFirestoreEmulator, collection, getDocFromServer, getDocsFromServer, doc, writeBatch, deleteDoc, serverTimestamp} = await import("firebase/firestore");
    const {fetchFirebaseDevices} = await import("./firebase/viewerFirebase");
    const {mapFirestoreDevice} = await import("./firebase/firestoreDevice");
    const {prepareViewerDeviceList} = await import("./domain/viewerDeviceList");
    const {subscribeAgentCommandsWithFirebase,sendAgentHeartbeatWithFirebase} = await import("./firebase/agentFirebase");
    const projectId = `demo-refresh-${crypto.randomUUID().slice(0,8)}`, deviceId = "device-0", installId = "timing-install";
    const selectedIds = grouped ? [deviceId,"device-1","device-2"] : [deviceId];
    const seededIds = grouped ? [...selectedIds,"device-3"] : selectedIds;
    const benchmarkIds = grouped ? Array.from({length:61},(_,index)=>`bench-${index}`) : [];
    const apps: ReturnType<typeof initializeApp>[] = [];
    const createClient = (appId:string, viewer:boolean) => {
      const app = initializeApp({projectId,apiKey:"loopback-only",authDomain:"localhost",appId}, appId);
      apps.push(app);
      const db = getFirestore(app);
      const uid = appId;
      connectFirestoreEmulator(db,"127.0.0.1",Number(address.split(":")[1]),{mockUserToken:{sub:uid,wonremoteViewer:viewer}});
      localFirebaseServices.set(appId,{db,auth:{currentUser:{uid}}});
      return {db,uid,env:{VITE_WONREMOTE_FIREBASE_PROJECT_ID:projectId,VITE_WONREMOTE_FIREBASE_API_KEY:"loopback-only",
        VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN:"localhost",VITE_WONREMOTE_FIREBASE_APP_ID:appId}};
    };
    const agentErrors: Error[] = [], replies: string[] = [];
    let stop: (()=>void) | undefined;
    let clearFixture: (()=>Promise<void>) | undefined;
    try {
      const agent = createClient("timing-agent",false), viewer = createClient("timing-viewer",true);
      const viewerEnv = {...import.meta.env,...viewer.env};
      const commandsRef = collection(viewer.db,"devices",deviceId,"commands");
      clearFixture = async () => {
        const {docs} = await getDocsFromServer(commandsRef);
        await Promise.all(docs.map(command=>deleteDoc(command.ref)));
        const ids = [...seededIds,...benchmarkIds];
        // Device deletes also read the lock document in the security rules.
        for (let start=0; start<ids.length; start+=10) {
          const deletions = writeBatch(viewer.db);
          for (const id of ids.slice(start,start+10)) deletions.delete(doc(viewer.db,"devices",id));
          await deletions.commit();
        }
      };
      const seed = writeBatch(agent.db);
      [...seededIds,...benchmarkIds].forEach((id,index) => seed.set(doc(agent.db,"devices",id),{
        ownerUid:agent.uid,installId,status:"online",presenceMode:index===0?"manual":"periodic",
        businessNumber:"123-45-67890",deviceNumber:`AGENT-TIMING-${index}`,desktopName:`PC-${index}`,
        deviceName:"POS",storeName:grouped&&index<3?"GroupRefresh":"Store",protocolVersion:2,
        lastSeenAt:serverTimestamp(),lastSeenAtServer:serverTimestamp(),
      }));
      await seed.commit();
      let ready = false;
      stop = await subscribeAgentCommandsWithFirebase({deviceId,installId,onReady:()=>{ ready = true; }},async commands => {
        for (const {action} of commands) {
          const nonce = /^refresh-status ([a-f0-9-]{36})$/.exec(action)?.[1];
          if (!nonce) throw new Error("Unexpected command in timing fixture.");
          await sendAgentHeartbeatWithFirebase({deviceId,installId,presenceMode:"manual",heartbeatRequestId:nonce,protocolVersion:2},agent.env);
          replies.push(nonce);
        }
      },error=>agentErrors.push(error),agent.env);
      await vi.waitFor(() => expect(ready).toBe(true), {timeout:3_000});
      const samples: number[] = [];
      for (let attempt=0; attempt<5; attempt++) {
        const abort = new AbortController();
        let probe: Promise<ManagedDevice[]> | undefined;
        const page = await openViewer({manual:true},browser,async page => {
          if (grouped) await page.evaluate(()=>{
            const devices = (window as any).testState.devices;
            devices[0].storeName = devices[1].storeName = devices[2].storeName = "GroupRefresh";
            devices[1].presenceMode = devices[2].presenceMode = "periodic";
          });
        });
        try {
          const row = page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})});
          await row.getByText("오프라인",{exact:true}).waitFor();
          await page.exposeFunction("readLocalRefresh",(known:ManagedDevice[], ids?:string[]) => {
            expect([...ids!].sort()).toEqual(selectedIds);
            if (probe) throw new Error("Unexpected duplicate refresh in timing fixture.");
            probe = (async () => {
              let delivered = Promise.resolve();
              let deliveryError: unknown;
              const result = await fetchFirebaseDevices(viewerEnv,true,abort.signal,(devices,pending) => {
                delivered = delivered.then(async () => {
                  if (!abort.signal.aborted) await page.evaluate(value => (window as any).showLocalRefresh(value),{devices,pending});
                }).catch(error => { deliveryError ??= error; });
              },known,ids).finally(() => delivered);
              if (deliveryError) throw deliveryError;
              expect(result.map(device=>[device.id,device.status]).sort()).toEqual(selectedIds.map(id=>[id,"online"]));
              return result;
            })();
            return probe;
          });
          const search = page.getByPlaceholder("매장, 장비, 담당자, 연락처, 메모 검색");
          await search.fill(grouped?"GroupRefresh":"PC-0");
          await page.evaluate(() => {
            const w = window as any;
            w.testApi.fetchFirebaseDevices = (_env:unknown,_refresh:boolean,signal:AbortSignal,
              onProgress:(devices:unknown,pending:unknown)=>void,known:unknown,ids:unknown) => {
              w.showLocalRefresh = ({devices,pending}:{devices:ManagedDevice[];pending:string[]}) => {
                if (signal.aborted) return;
                w.refreshNonce = pending.length ? undefined : devices.find(device=>device.id==="device-0")?.heartbeatRequestId;
                onProgress(devices,pending);
              };
              return w.readLocalRefresh(known,ids).finally(() => { w.refreshDone = true; });
            };
          });
          await refresh(page).evaluate((button,grouped) => button.addEventListener("click", () => {
            const start = performance.now();
            const w = window as any;
            const isVisibleOnline = () => {
              return (grouped ? ["PC-0","PC-1","PC-2"] : ["PC-0"]).every(name => {
                const row = document.querySelector(`input[aria-label="${name} 선택"]`)?.closest(".table-row");
                const status = row?.querySelector(".status-pill.online");
                return Boolean(status?.textContent?.trim() === "온라인" && status.getClientRects().length
                  && document.visibilityState === "visible");
              });
            };
            const record = () => {
              if (isVisibleOnline()) {
                const nonce = w.refreshNonce;
                requestAnimationFrame(() => {
                  if (isVisibleOnline()) w.refreshTiming = {ms:performance.now()-start,nonce};
                  else record();
                });
              } else if (performance.now()-start<5_500) requestAnimationFrame(record);
            };
            requestAnimationFrame(record);
          },{capture:true,once:true}),grouped);
          await refresh(page).click();
          await row.getByText("온라인",{exact:true}).waitFor();
          await probe;
          await page.waitForFunction(() => (window as any).refreshTiming);
          const sample:{ms:number;nonce?:string} = await page.evaluate(() => (window as any).refreshTiming);
          samples.push(sample.ms);
          await expect.poll(() => replies.length).toBe(attempt+1);
          expect(sample.nonce).toBe(replies[attempt]);
          await page.waitForFunction(() => (window as any).refreshDone);
          if (grouped) {
            await search.fill("");
            await page.locator(".table-row").filter({has:page.getByText("PC-3",{exact:true})}).getByText("오프라인",{exact:true}).waitFor();
          }
        } finally {
          abort.abort();
          await probe?.catch(() => {});
          await page.close();
        }
      }
      expect(agentErrors).toEqual([]);
      expect(new Set(replies).size).toBe(5);
      const commands = (await getDocsFromServer(commandsRef)).docs;
      expect(commands.map(command=>command.data().state)).toEqual(Array(5).fill("delivered"));
      const [first, ...warm] = samples.map(ms=>Math.round(ms));
      process.stdout.write(`Local searched refresh click to visible rows (grouped: ${grouped}, ms): first=${first}; warm=${warm.join(", ")}\n`);
      if (grouped) {
        const baseline = async () => {
          const snapshots = await Promise.all(benchmarkIds.map(id=>getDocFromServer(doc(viewer.db,"devices",id))));
          const rows = snapshots.flatMap(snapshot=>snapshot.exists()?[mapFirestoreDevice(snapshot.id,snapshot.data())]:[]);
          return prepareViewerDeviceList(rows,new Date().toISOString()).map(device=>device.id);
        };
        const groupedRead = async () => (await fetchFirebaseDevices(viewerEnv,false,undefined,undefined,[],benchmarkIds)).map(device=>device.id);
        const timed = async (read:()=>Promise<string[]>) => {
          const start = performance.now();
          const ids = await read();
          const elapsed = Math.round(performance.now()-start);
          expect(ids.sort()).toEqual([...benchmarkIds].sort());
          return elapsed;
        };
        const pairs = [];
        for (let index=0; index<5; index++) {
          if (index%2===0) pairs.push({individual:await timed(baseline),batched:await timed(groupedRead)});
          else {
            const batched = await timed(groupedRead);
            pairs.push({individual:await timed(baseline),batched});
          }
        }
        process.stdout.write(`Local 61-ID server lookup comparison (ms, excludes UI and heartbeat): ${JSON.stringify(pairs)}\n`);
      }
    } finally {
      stop?.();
      try { await clearFixture?.(); }
      finally {
        localFirebaseServices.clear();
        await Promise.all(apps.map(app=>deleteApp(app)));
      }
    }
  }, 30_000);

  it("measures a 1080p pointer round trip through visible pixels", async () => {
    const {wireViewerToLocalPeer} = await import("./firebase/browserRtcFixture");
    const wireBrowser = await chromium.launch({headless:true,args:["--allow-loopback-in-peer-connection","--disable-features=WebRtcHideLocalIpsWithMdns"]});
    let wire: Awaited<ReturnType<typeof wireViewerToLocalPeer>> | undefined;
    try {
      const page = await openViewer({connected:true},wireBrowser);
      const colors = [[40,180,210],[210,70,40],[80,210,90],[165,85,210],[210,160,40],[50,100,220]];
      const {base, markers} = await page.evaluate(colors => {
        const width=1920,height=1080;
        const source = document.createElement("canvas");
        const tile = (x:number,y:number,w:number,h:number,color:string) => {
          source.width=w;source.height=h;
          const ctx=source.getContext("2d")!;
          ctx.fillStyle=color;ctx.fillRect(0,0,w,h);
          return {x:x/32,y:y/32,w,h,data:source.toDataURL("image/jpeg").split(",")[1]};
        };
        const tiles = [tile(0,0,960,544,"#142030"),tile(960,0,960,544,"#142030"),
          tile(0,544,960,536,"#142030"),tile(960,544,960,536,"#142030")];
        return {base:{sequence:1,keyframe:true,width,height,tiles},markers:colors.map(rgb=>tile(0,0,32,32,`rgb(${rgb.join(",")})`))};
      },colors);
      type Echo = {index:number; expectedX:number; peerAt?:number; sent?:string};
      let armed: Echo | null = null;
      wire = await wireViewerToLocalPeer(page,[base],(action,peer,receivedAt)=>{
        if (!armed || Math.abs(Number(action.split(" ")[1])-armed.expectedX)>200) return;
        const echo=armed;
        armed=null;
        echo.peerAt=receivedAt;
        echo.sent=wire!.sendFrame(peer,{...base,keyframe:false,sequence:echo.index+2,tiles:[markers[echo.index]]});
      });
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.getByText("Store · 화면 수신 중",{exact:true}).waitFor();
      expect(wire.framesSent).toEqual(["sent"]);
      const canvas = page.locator(".remote-canvas");
      const box=(await canvas.boundingBox())!;
      const timings: {inputToPeerMs:number;peerToPictureMs:number;inputToPictureMs:number}[]=[];
      for (const [index,color] of colors.entries()) {
        const fraction=.20+index*.11;
        const echo: Echo={index,expectedX:Math.round(fraction*65535)};
        armed=echo;
        const painted=canvas.evaluate(async (node,color)=>{
          const ctx=(node as HTMLCanvasElement).getContext("2d")!;
          const deadline=performance.now()+2500;
          while(performance.now()<deadline) {
            await new Promise(requestAnimationFrame);
            const pixel=ctx.getImageData(1,1,1,1).data;
            if (!color.every((value,index)=>Math.abs(pixel[index]-value)<8)) continue;
            await new Promise(requestAnimationFrame);
            return Date.now();
          }
          throw new Error("The pointer's picture update never reached the visible canvas.");
        },color);
        const sentAt=Date.now();
        const [visibleAt]=await Promise.all([painted,page.mouse.move(box.x+box.width*fraction,box.y+box.height/2)]);
        expect(echo.sent).toBe("sent");
        expect(echo.peerAt).toBeDefined();
        expect(visibleAt).toBeGreaterThanOrEqual(echo.peerAt!);
        timings.push({inputToPeerMs:echo.peerAt!-sentAt,peerToPictureMs:visibleAt-echo.peerAt!,inputToPictureMs:visibleAt-sentAt});
      }
      process.stdout.write(`1080p visible pointer response: ${JSON.stringify(timings)}\n`);
    } finally {
      try { await wire?.close(); }
      finally { await wireBrowser.close(); }
    }
  },15_000);

  it("measures a dropped 1080p pointer picture through the Agent repair and Viewer canvas", async () => {
    const { captureStartup } = await import("./agent/captureStartupFixture");
    const { wireViewerToLocalPeer } = await import("./firebase/browserRtcFixture");
    const wireBrowser = await chromium.launch({ headless: true, args: ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
    let wire: Awaited<ReturnType<typeof wireViewerToLocalPeer>> | undefined;
    let captureWork: Promise<void> | undefined;
    let cancelCaptureRepair: (() => void) | undefined;
    type Sample = { peerAt?: number; recoveryAt?: number; recoveredOnProgress?: boolean; expectedX: number; index: number; pressureAfterSend: number; sends: string[] };
    let armed: Sample | undefined;
    try {
      const page = await openViewer({ connected: true }, wireBrowser);
      const colors = [[200, 60, 40], [60, 200, 40]];
      const { base, cases, progressTile } = await page.evaluate(colors => {
        const width = 1920, height = 1080;
        const source = document.createElement("canvas");
        const tile = (x: number, y: number, w: number, h: number, color: string) => {
          source.width = w; source.height = h;
          const ctx = source.getContext("2d")!;
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, w, h);
          return { x: x / 32, y: y / 32, w, h, data: source.toDataURL("image/jpeg").split(",")[1] };
        };
        const tiles = [tile(0, 0, 960, 544, "#142030"), tile(960, 0, 960, 544, "#142030"),
          tile(0, 544, 960, 536, "#142030"), tile(960, 544, 960, 536, "#142030")];
        return { base: { sequence: 1, keyframe: true, width, height, tiles }, progressTile: tile(32, 0, 32, 32, "#80a0d0"),
          cases: colors.map(color => ({ color, picture: [tile(0, 0, 960, 544, `rgb(${color.join(",")})`), ...tiles.slice(1)],
            skipped: tile(0, 0, 32, 32, `rgb(${color.join(",")})`) })) };
      }, colors);
      const { start, stdoutHandlers, context } = captureStartup();
      await start("device-0", "local-picture-repair");
      cancelCaptureRepair = () => {
        if (context.keyframeRetryTimer !== null) clearTimeout(context.keyframeRetryTimer);
        context.keyframeRetryTimer = null;
      };
      context.streamFrameSequence = base.sequence;
      const receiveCapture = (tiles: typeof base.tiles, keyframe = false) => stdoutHandlers[0](JSON.stringify({
        type: "frame", width: base.width, height: base.height, keyframe, tiles,
      }));
      let queuedBytes = 0;
      Object.assign(context, { webRtcTransport: {
        sendFrame: (frame: typeof base, maxBufferedAmount?: number) => {
          const result = wire!.sendFrame(0, frame, { queuedBytes, maxBufferedAmount });
          armed?.sends.push(result);
          return result;
        },
        getBufferedAmount: () => queuedBytes,
      } });
      context.writeCaptureControl.mockImplementation((_input, command, _fail, written) => {
        const sample = armed;
        if (!sample) return false;
        if (command !== "request-keyframe\n" || sample.recoveryAt !== undefined) throw new Error("Unexpected capture repair request");
        sample.recoveryAt = Date.now();
        written?.();
        void receiveCapture(cases[sample.index].picture, true);
        return true;
      });
      wire = await wireViewerToLocalPeer(page, [base], (action, _peer, receivedAt) => {
        const sample = armed;
        if (!sample || sample.peerAt !== undefined || Math.abs(Number(action.split(" ")[1]) - sample.expectedX) > 200) return;
        sample.peerAt = receivedAt;
        captureWork = (async () => {
          queuedBytes = 512 * 1024;
          await receiveCapture([cases[sample.index].skipped]);
          await new Promise(resolve => setTimeout(resolve, 32));
          queuedBytes = sample.pressureAfterSend;
          const alreadyRequested = sample.recoveryAt !== undefined;
          await receiveCapture([progressTile]);
          sample.recoveredOnProgress = !alreadyRequested && sample.recoveryAt !== undefined;
        })();
      });
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      await expect.poll(() => wire!.controls.includes("request-keyframe")).toBe(true);
      const canvas = page.locator(".remote-canvas");
      const box = (await canvas.boundingBox())!;
      const timings: { repairRequestMs: number; playwrightCallToCanvasMs: number }[] = [];
      for (const [index, pressureAfterSend] of [400 * 1024, 16 * 1024].entries()) {
        // Measure independent drops, not two drops within one recovery cooldown.
        if (index) await new Promise(resolve => setTimeout(resolve, 250));
        const fraction = .20 + index * .29;
        const sample: Sample = { expectedX: Math.round(fraction * 65535), index, pressureAfterSend, sends: [] };
        armed = sample;
        const painted = canvas.evaluate(async (node, color) => {
          const ctx = (node as HTMLCanvasElement).getContext("2d")!;
          const deadline = performance.now() + 2_500;
          while (performance.now() < deadline) {
            await new Promise(requestAnimationFrame);
            const pixel = ctx.getImageData(1, 1, 1, 1).data;
            if (!color.every((value, i) => Math.abs(pixel[i] - value) < 8)) continue;
            await new Promise(requestAnimationFrame);
            return Date.now();
          }
          throw new Error("The missed pointer picture did not recover.");
        }, cases[index].color);
        const playwrightCallAt = Date.now();
        const [visibleAt] = await Promise.all([painted, page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2)]);
        await captureWork;
        expect(sample.peerAt).toBeDefined();
        expect(sample.recoveryAt).toBeDefined();
        expect(sample.sends).toEqual(["backpressure", "sent", "sent"]);
        expect(sample.recoveredOnProgress).toBe(index === 1);
        expect(visibleAt).toBeGreaterThanOrEqual(sample.recoveryAt!);
        timings.push({ repairRequestMs: sample.recoveryAt! - sample.peerAt!, playwrightCallToCanvasMs: visibleAt - playwrightCallAt });
      }
      process.stdout.write(`1080p dropped picture recovery (deadline, early): ${JSON.stringify(timings)}\n`);
      expect(context.writeCaptureControl).toHaveBeenCalledTimes(2);
    } finally {
      armed = undefined;
      try { await captureWork; }
      finally {
        cancelCaptureRepair?.();
        try { await wire?.close(); }
        finally { await wireBrowser.close(); }
      }
    }
  }, 15_000);

  it("shows distinct late 1080p pixels even when a complete packet overtakes eight fragmented pictures", async () => {
    const { wireViewerToLocalPeer } = await import("./firebase/browserRtcFixture");
    const { WEBRTC_TILE_CHANNEL_LABEL } = await import("./domain/webrtcControl");
    const wireBrowser = await chromium.launch({ headless: true, args: ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
    let wire: Awaited<ReturnType<typeof wireViewerToLocalPeer>> | undefined;
    try {
      const page = await openViewer({ connected: true }, wireBrowser);
      const { base, markers } = await page.evaluate(label => {
        const create = RTCPeerConnection.prototype.createDataChannel;
        const sequences: number[] = (window as any).receivedTileSequences = [];
        RTCPeerConnection.prototype.createDataChannel = function(name, options) {
          const channel = create.call(this, name, options);
          if (name === label) channel.addEventListener("message", ({ data }) => { sequences.push(JSON.parse(data).sequence); });
          return channel;
        };
        const width = 1920, height = 1080;
        const source = document.createElement("canvas");
        const tile = (x: number, w: number, h: number, color: string) => {
          source.width = w; source.height = h;
          const ctx = source.getContext("2d")!;
          ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
          return { x, y: 0, w, h, data: source.toDataURL("image/jpeg").split(",")[1] };
        };
        return { base: { sequence: 1, keyframe: true, width, height, tiles: [tile(0, width, height, "#000000")] },
          markers: [tile(0, 32, 32, "#ff0000"), tile(1, 32, 32, "#00ff00"), tile(2, 32, 32, "#0000ff")] };
      }, WEBRTC_TILE_CHANNEL_LABEL);
      wire = await wireViewerToLocalPeer(page, [base]);
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      const send = (sequence: number, frameChunkCount: number, frameChunkIndex: number, index: number) =>
        wire!.sendTilePacket(0, { ...base, keyframe: false, sequence, frameChunkCount, frameChunkIndex, tiles: [markers[index]] });
      const pixels = () => page.locator(".remote-canvas").evaluate(node => {
        const context = (node as HTMLCanvasElement).getContext("2d")!;
        return [1, 33, 65].map(x => Array.from(context.getImageData(x, 1, 1, 1).data.slice(0, 3)).findIndex(channel => channel > 240));
      });
      for (let sequence = 2; sequence <= 9; sequence++) send(sequence, 2, 0, 0);
      // Observe delivery, since the real tile channel is unordered.
      await expect.poll(() => page.evaluate(() => (window as any).receivedTileSequences.filter((n: number) => n >= 2 && n <= 9).length)).toBe(8);
      send(10, 1, 0, 2);
      await expect.poll(pixels).toEqual([-1, -1, 2]);
      send(2, 2, 1, 1);
      await expect.poll(pixels).toEqual([0, 1, 2]);
    } finally {
      try { await wire?.close(); }
      finally { await wireBrowser.close(); }
    }
  }, 15_000);

  it.each([1920,3840])("measures a %i-wide picture and sends input over an actual local WebRTC channel", async width => {
    const height = width * 9 / 16;
    const is4k = width === 3840;
    const useSwap = is4k ? [false,true,true,false] : [true,true,true];
    const {wireViewerToLocalPeer} = await import("./firebase/browserRtcFixture");
    const wireBrowser = await chromium.launch({headless:true,args:["--allow-loopback-in-peer-connection","--disable-features=WebRtcHideLocalIpsWithMdns"]});
    let wire: Awaited<ReturnType<typeof wireViewerToLocalPeer>> | undefined;
    try {
      const page = await openViewer({connected:true},wireBrowser);
      const viewerCpu = await page.context().newCDPSession(page);
      const mouseDriver = is4k ? await page.context().newCDPSession(page) : null;
      await page.evaluate(() => {
        const sources = new WeakSet<HTMLCanvasElement>();
        const counts = { copies: 0, surfaces: 0 };
        (window as any).wireStagingProof = counts;
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          Reflect.apply(drawImage, this, args);
          const source = args[0];
          if (source instanceof HTMLCanvasElement && this.canvas.matches(".remote-canvas,.remote-picture-alternate")) {
            counts.copies++;
            if (!sources.has(source)) {
              sources.add(source);
              counts.surfaces++;
            }
          }
        };
      });
      if (is4k) await page.evaluate(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
          if ((window as any).loopbackDisableAlternate && args[0] === "2d" && this.classList.contains("remote-picture-alternate")) return null;
          return Reflect.apply(getContext,this,args);
        };
        document.addEventListener("pointermove",event => {
          if (event.isTrusted && event.target instanceof HTMLCanvasElement && event.target.classList.contains("remote-canvas")) {
            (window as any).wireTrustedMoves?.push({x:event.clientX,receivedAt:Date.now()});
          }
        },true);
      });
      const palettes = [[[215,33,51],[25,85,212]],[[41,212,85],[228,196,25]],[[156,53,199],[38,209,196]]];
      const frames = await page.evaluate(({palettes,width,height}) => palettes.map(([left,right]) => {
        const size = width / 15;
        const source = document.createElement("canvas");
        const tiles = [];
        for (let y = 0; y < height; y += size) {
          for (let x = 0; x < width; x += size) {
            const w = Math.min(size,width-x), h = Math.min(size,height-y);
            source.width = w; source.height = h;
            const ctx = source.getContext("2d")!;
            ctx.fillStyle = `rgb(${(x < width / 2 ? left : right).join(",")})`;
            ctx.fillRect(0,0,w,h);
            tiles.push({x:x/32,y:y/32,w,h,data:source.toDataURL("image/jpeg").split(",")[1]});
          }
        }
        return {sequence:1,keyframe:true,width,height,tiles};
      }),{palettes,width,height});
      wire = await wireViewerToLocalPeer(page,is4k ? useSwap.map(() => frames[0]) : frames);
      await page.evaluate(() => {
        const prefix = "[ConnectionTiming] ";
        const original = console.info.bind(console);
        const proof: unknown[] = [];
        (window as any).wirePixelProof = proof;
        console.info = (value,...rest) => {
          if (typeof value === "string" && value.startsWith(prefix)) {
            const timing = JSON.parse(value.slice(prefix.length));
            if (timing.stage === "first-picture") {
              const canvas = document.querySelector<HTMLCanvasElement>(".session-panel:not(.session-panel-inactive) .remote-canvas");
              const ctx = canvas?.getContext("2d");
              proof.push({
                attempt:timing.attempt,width:canvas?.width,height:canvas?.height,
                visible:Boolean(canvas?.getClientRects().length && getComputedStyle(canvas).visibility === "visible"),
                pixels:ctx && canvas ? [[1,1],[canvas.width-2,canvas.height-2]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3)) : [],
              });
            }
          }
          original(value,...rest);
        };
      });
      const timing: {attempt:number;stage:string;elapsedMs:number}[] = [];
      page.on("console",message => {
        const prefix = "[ConnectionTiming] ";
        if (message.text().startsWith(prefix)) timing.push(JSON.parse(message.text().slice(prefix.length)));
      });
      const row = page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})});
      const canvas = page.locator(".remote-canvas");
      for (const [index, canSwap] of useSwap.entries()) {
        const round = index + 1;
        const basePicture = is4k ? 0 : index;
        if (is4k) await page.evaluate(canSwap => { (window as any).loopbackDisableAlternate = !canSwap; },canSwap);
        await row.getByRole("button",{name:"접속",exact:true}).click();
        await expect.poll(() => timing.filter(stage=>stage.stage==="first-picture").length,{timeout:6_000}).toBe(round);
        const picture = timing.filter(stage=>stage.stage==="first-picture")[round-1];
        const proof = await page.evaluate(round => (window as any).wirePixelProof[round-1],round);
        expect(proof).toMatchObject({attempt:picture.attempt,width,height,visible:true});
        expect(proof.pixels).toHaveLength(2);
        palettes[basePicture].forEach((color,index)=>color.forEach((value,channel)=>{
          expect(Math.abs(proof.pixels[index][channel]-value)).toBeLessThan(8);
        }));
        {
          const cpuSlowdown = is4k || round === 3 ? 4 : 1;
          if (cpuSlowdown > 1) await viewerCpu.send("Emulation.setCPUThrottlingRate", {rate:cpuSlowdown});
          const box = (await canvas.boundingBox())!;
          const x = box.x+box.width/4, y = box.y+box.height/3;
          const beforeMove = wire.motionReceipts.length;
          await page.mouse.move(x,y);
          await expect.poll(() => wire!.motionReceipts.length).toBeGreaterThan(beforeMove);
          const move = wire.controls.filter(action=>action.startsWith("move ")).pop()!.split(" ").slice(1).map(Number);
          expect(Math.abs(move[0]-16384)).toBeLessThan(200);
          expect(Math.abs(move[1]-21845)).toBeLessThan(200);
          const firstReceipt = wire.motionReceipts.length;
          const beforeStaging: { copies: number; surfaces: number } = await page.evaluate(() => (window as any).wireStagingProof);
          let deltaSequence = 1, deltasSent = 0;
          const alternate = frames.filter((_, index) => index !== basePicture);
          const deltaTiles = alternate.map(frame => is4k || round > 1 ? frame.tiles : frame.tiles.slice(0, 1));
          const timer = setInterval(() => {
            const tiles = deltaTiles[Math.floor(deltasSent / 4) % deltaTiles.length];
            if (wire!.sendFrame(round - 1, { ...frames[basePicture], tiles, keyframe: false, sequence: ++deltaSequence }) === "sent") deltasSent++;
          }, 33);
          const rendererSweep = () => canvas.evaluate(async element => {
            const bounds = element.getBoundingClientRect();
            const inputs: { action: string; sentAt: number }[] = [];
            const rgbDuringSweep: number[][] = [];
            for (let index = 0; index < 60; index++) {
              await new Promise(requestAnimationFrame);
              const clientX = bounds.left + bounds.width * (0.15 + index / 100);
              const clientY = bounds.top + bounds.height / 2;
              const event = new PointerEvent("pointermove", { clientX, clientY, pointerType: "mouse", pointerId: 1, bubbles: true });
              const dx = Math.round((event.clientX - bounds.left) / bounds.width * 65535);
              const dy = Math.round((event.clientY - bounds.top) / bounds.height * 65535);
              inputs.push({ action: `move ${dx} ${dy}`, sentAt: Date.now() });
              element.dispatchEvent(event);
              if (index % 5 === 4) {
                const shown = element.parentElement?.dataset.pictureBuffer === "alternate"
                  ? element.parentElement.querySelector<HTMLCanvasElement>(".remote-picture-alternate")! : element as HTMLCanvasElement;
                rgbDuringSweep.push(Array.from(shown.getContext("2d")!.getImageData(1, 1, 1, 1).data));
              }
            }
            return { inputs, rgbDuringSweep };
          });
          let browserIngress: { received: number; p95Ms: number } | undefined;
          const trustedSweep = async () => {
            if (!mouseDriver) return rendererSweep();
            await page.evaluate(() => { (window as any).wireTrustedMoves = []; });
            const inputs: { action: string; sentAt: number }[] = [];
            const timestamps = new Map<number,number>();
            const sends: Promise<unknown>[] = [];
            const pixels: Promise<number[] | Error>[] = [];
            const clientY = Math.round(box.y + box.height / 2);
            const dy = Math.round((clientY - box.y) / box.height * 65535);
            for (let index = 0; index < 60; index++) {
              const clientX = Math.round(box.x + box.width * (0.15 + index / 100));
              const dx = Math.round((clientX - box.x) / box.width * 65535);
              const sentAt = Date.now();
              inputs.push({action:`move ${dx} ${dy}`,sentAt});
              timestamps.set(clientX,sentAt);
              sends.push(mouseDriver.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:clientX,y:clientY}).catch(error=>error));
              if (index % 5 === 4) pixels.push(canvas.evaluate(element => {
                const shown = element.parentElement?.dataset.pictureBuffer === "alternate"
                  ? element.parentElement.querySelector<HTMLCanvasElement>(".remote-picture-alternate")! : element as HTMLCanvasElement;
                return Array.from(shown.getContext("2d")!.getImageData(1,1,1,1).data);
              }).catch(error=>error));
              if (index < 59) await new Promise(resolve=>setTimeout(resolve,16));
            }
            for (const result of await Promise.all(sends)) if (result instanceof Error) throw result;
            const rgbDuringSweep = (await Promise.all(pixels)).map(result => {
              if (result instanceof Error) throw result;
              return result;
            });
            const browserMoves: {x:number;receivedAt:number}[] = await page.evaluate(() => {
              const w = window as any, trace = w.wireTrustedMoves;
              delete w.wireTrustedMoves;
              return trace;
            });
            const ingressTimes = browserMoves.flatMap(event => timestamps.has(event.x) ? [event.receivedAt - timestamps.get(event.x)!] : []).sort((a,b)=>a-b);
            expect(ingressTimes.length).toBeGreaterThan(0);
            browserIngress = {received:ingressTimes.length,p95Ms:ingressTimes[Math.ceil(ingressTimes.length * .95)-1]};
            return {inputs,rgbDuringSweep};
          };
          const { inputs, rgbDuringSweep } = await trustedSweep().finally(() => clearInterval(timer));
          const lastInput = inputs[inputs.length - 1];
          await expect.poll(() => wire!.motionReceipts[wire!.motionReceipts.length - 1]?.action).toBe(lastInput.action);
          const receipts = wire.motionReceipts.slice(firstReceipt);
          const inputIndex = new Map(inputs.map((input, index) => [input.action, index]));
          const delivered = receipts.map(receipt => inputIndex.get(receipt.action)!);
          // The artificial slowdown measures degradation, not a hardware performance gate.
          expect(delivered.length).toBeGreaterThanOrEqual(cpuSlowdown === 1 ? 45 : 2);
          expect(delivered.every((index, position) => Number.isInteger(index) && (!position || index > delivered[position - 1]))).toBe(true);
          expect(deltasSent).toBeGreaterThan(15);
          for (const [expected] of palettes.filter((_, index) => index !== basePicture)) {
            expect(rgbDuringSweep.some(rgb => expected.every((channel, index) => Math.abs(channel - rgb[index]) < 8))).toBe(true);
          }
          const afterStaging: typeof beforeStaging = await page.evaluate(() => (window as any).wireStagingProof);
          const delays = receipts.map((receipt, index) => receipt.receivedAt - inputs[delivered[index]].sentAt).sort((a, b) => a - b);
          const gaps = receipts.slice(1).map((receipt, index) => receipt.receivedAt - receipts[index].receivedAt);
          const dispatchGaps = inputs.slice(1).map((input,index) => input.sentAt-inputs[index].sentAt);
          process.stdout.write(`Local pointer during picture tiles: ${JSON.stringify({ width, canSwap, cpuSlowdown, tilesPerFrame: deltaTiles[0].length, sent: inputs.length, received: receipts.length, deltasSent,
            sweepMs: lastInput.sentAt - inputs[0].sentAt,browserIngress,
            medianMs: delays[Math.floor(delays.length / 2)], p95Ms: delays[Math.ceil(delays.length * 0.95) - 1], maxDispatchGapMs:Math.max(...dispatchGaps), maxReceiptGapMs: Math.max(...gaps),
            stagingCopies: afterStaging.copies - beforeStaging.copies, stagingSurfaces: afterStaging.surfaces - beforeStaging.surfaces })}\n`);
          if (is4k || round > 1) {
            const copies = afterStaging.copies - beforeStaging.copies;
            if (canSwap) expect(copies).toBe(0);
            else expect(copies).toBeGreaterThan(2);
          }
          if (!is4k && round === 2) {
            const inspectPicture = () => canvas.evaluate(node => {
              const base = node as HTMLCanvasElement;
              const parent = base.parentElement!;
              const buffer = parent.dataset.pictureBuffer;
              const alternate = parent.querySelector<HTMLCanvasElement>(".remote-picture-alternate")!;
              const shown = buffer === "alternate" ? alternate : base;
              const picture = shown.getContext("2d")!;
              const rect = shown.getBoundingClientRect();
              const input = base.getBoundingClientRect();
              const standby = alternate.getBoundingClientRect();
              const alternateStyle = getComputedStyle(alternate);
              const sameBounds = (other: DOMRect) => [other.x,other.y,other.width,other.height]
                .every((value,index)=>value === [input.x,input.y,input.width,input.height][index]);
              return { buffer, pixels: [[1,1],[shown.width-2,shown.height-2]].map(([x,y])=>Array.from(picture.getImageData(x,y,1,1).data).slice(0,3)),
                displayed: getComputedStyle(shown).opacity === "1" && (shown === base || getComputedStyle(base).opacity === "0"),
                aligned: sameBounds(rect),
                standbyStable: buffer ? sameBounds(standby) && alternateStyle.visibility === (buffer === "alternate" ? "visible" : "hidden")
                  : alternateStyle.display === "none",
                hitInput: document.elementFromPoint(input.x+input.width/2,input.y+input.height/2) === base };
            });
            const beforeFailure = await inspectPicture();
            expect(beforeFailure.buffer).toMatch(/^(primary|alternate)$/);
            expect(beforeFailure).toMatchObject({aligned:true,hitInput:true,displayed:true,standbyStable:true});
            await canvas.evaluate(node => {
              const base = node as HTMLCanvasElement;
              const parent = base.parentElement!;
              const back = parent.dataset.pictureBuffer === "alternate" ? base : parent.querySelector<HTMLCanvasElement>(".remote-picture-alternate")!;
              const context = back.getContext("2d", { willReadFrequently:true })!;
              const draw = context.drawImage;
              context.drawImage = function (...args: unknown[]) {
                Reflect.deleteProperty(context,"drawImage");
                Reflect.apply(draw,context,args);
                throw new Error("Stop after a partial back-buffer draw");
              };
            });
            const sendPicture = (tiles = frames[round-1].tiles, keyframe = false) => {
              expect(wire!.sendFrame(round - 1,{...frames[round-1],tiles,keyframe,sequence:++deltaSequence})).toBe("sent");
            };
            const retryPicture = page.getByRole("button",{name:"원격 연결 새로고침"});
            sendPicture();
            await expect.poll(() => retryPicture.isEnabled()).toBe(true);
            expect(await inspectPicture()).toEqual(beforeFailure);
            sendPicture(frames[round-1].tiles.slice(0,1));
            await expect.poll(async () => (await inspectPicture()).pixels[0][1]).toBeGreaterThan(200);
            expect(await inspectPicture()).toMatchObject({buffer:beforeFailure.buffer,pixels:[expect.any(Array),beforeFailure.pixels[1]]});

            await page.getByRole("button",{name:"화면 확대",exact:true}).click();
            expect(await inspectPicture()).toMatchObject({aligned:true,hitInput:true});
            const dragBox = (await canvas.boundingBox())!;
            const dragStart = wire.controls.length;
            await page.mouse.move(dragBox.x+dragBox.width*.35, dragBox.y+dragBox.height*.35);
            await page.mouse.down();
            sendPicture();
            await expect.poll(() => retryPicture.isEnabled()).toBe(false);
            expect(await inspectPicture()).toMatchObject({buffer:beforeFailure.buffer === "alternate" ? "primary" : "alternate",aligned:true,hitInput:true,standbyStable:true});
            await page.mouse.move(dragBox.x+dragBox.width*.6, dragBox.y+dragBox.height*.55);
            await page.mouse.up();
            await expect.poll(() => wire!.controls.slice(dragStart).filter(action => /^(mouse-down|mouse-up) /.test(action)).map(action=>action.split(" ")[0]))
              .toEqual(["mouse-down","mouse-up"]);
            const release = wire.controls.slice(dragStart).find(action=>action.startsWith("mouse-up "))!.split(" ").slice(1,3).map(Number);
            expect(Math.abs(release[0]-39321)).toBeLessThan(200);
            expect(Math.abs(release[1]-36044)).toBeLessThan(200);
            if ((await inspectPicture()).buffer !== "alternate") {
              sendPicture();
              await expect.poll(async () => (await inspectPicture()).buffer).toBe("alternate");
            }
            const originalViewport = page.viewportSize()!;
            await page.setViewportSize({width:2300,height:1400});
            await page.getByRole("button",{name:"전체화면",exact:true}).click();
            await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(1920);
            await expect.poll(async () => (await inspectPicture()).aligned).toBe(true);
            expect(await inspectPicture()).toMatchObject({buffer:"alternate",hitInput:true,displayed:true});
            await page.getByRole("button",{name:"창모드",exact:true}).click();
            await page.setViewportSize(originalViewport);
            const resizedTile = await page.evaluate(() => {
              const source = document.createElement("canvas");
              source.width = 768;
              source.height = 1024;
              const context = source.getContext("2d")!;
              context.fillStyle = "#ff9900";
              context.fillRect(0,0,source.width,source.height);
              return { x:0,y:0,w:source.width,h:source.height,data:source.toDataURL("image/png").split(",")[1] };
            });
            const sendResizedPicture = () => expect(wire!.sendFrame(round - 1,{sequence:++deltaSequence,width:768,height:1024,keyframe:true,tiles:[resizedTile]})).toBe("sent");
            const intact = await inspectPicture();
            await canvas.evaluate(node => {
              const context = (node as HTMLCanvasElement).getContext("2d")!;
              context.isContextLost = () => true;
              context.drawImage = () => {};
            });
            sendResizedPicture();
            await expect.poll(() => retryPicture.isEnabled()).toBe(true);
            expect(await inspectPicture()).toEqual(intact);
            expect(await canvas.evaluate(node => [(node as HTMLCanvasElement).width,(node as HTMLCanvasElement).height])).toEqual([1920,1080]);
            await canvas.evaluate(node => {
              const context = (node as HTMLCanvasElement).getContext("2d")!;
              Reflect.deleteProperty(context,"isContextLost");
              Reflect.deleteProperty(context,"drawImage");
            });
            sendResizedPicture();
            await expect.poll(() => canvas.evaluate(node => [(node as HTMLCanvasElement).width,(node as HTMLCanvasElement).height])).toEqual([768,1024]);
            expect(await inspectPicture()).toMatchObject({buffer:undefined,pixels:[[255,153,0],[255,153,0]],aligned:true,hitInput:true,displayed:true,standbyStable:true});
            const centered = (await canvas.boundingBox())!;
            await page.mouse.move(centered.x+centered.width/2,centered.y+centered.height/2);
          }
          const beforeClick = wire.controls.length;
          await page.mouse.down(); await page.mouse.up();
          await expect.poll(() => wire!.controls.slice(beforeClick).filter(action => /^(mouse-down|mouse-up) /.test(action)).map(action=>action.split(" ")[0]))
            .toEqual(["mouse-down","mouse-up"]);
          if (cpuSlowdown > 1) await viewerCpu.send("Emulation.setCPUThrottlingRate", {rate:1});
        }
        await page.getByTestId("end-session").click();
        await row.getByRole("button",{name:"접속",exact:true}).waitFor();
        await expect.poll(() => page.evaluate(() => (window as any).localSignalListeners.size)).toBe(0);
        expect(wire.peers).toHaveLength(round);
        await wire.peers[round-1].close();
      }
      expect(wire.framesSent).toEqual(useSwap.map(() => "sent"));
      const samples = timing.filter(stage => stage.stage === "first-picture").map(picture => {
        const stages = timing.filter(stage=>stage.attempt===picture.attempt);
        const receive = stages.find(stage=>stage.stage==="frame-received");
        const opened = stages.find(stage=>stage.stage==="channel-open");
        expect(stages[0].stage).toBe("connect-click");
        expect(receive).toBeDefined();
        expect(opened).toBeDefined();
        expect(picture.elapsedMs).toBeGreaterThan(receive!.elapsedMs);
        return {channelOpenMs:opened!.elapsedMs,frameMs:receive!.elapsedMs,firstPictureMs:picture.elapsedMs};
      });
      console.info(`Local Viewer WebRTC ${width}x${height}`,{cold:samples[0],warm:samples.slice(1)});
    } finally {
      try { await wire?.close(); }
      finally { await wireBrowser.close(); }
    }
  }, 30_000);

  it.each([
    ["when an inactive session becomes visible", "tab", 1],
    ["when a background document becomes visible", "document", 1],
    ["without recording a closed session on reveal", "closed", 0],
    ["without recording a disconnected session on reveal", "disconnected", 0],
    ["when fresh diagnostic pixels replace a failed WebRTC frame", "diagnostic", 1],
    ["when a queued WebRTC frame expires behind a diagnostic frame", "diagnostic-race", 1],
  ] as const)("times the first visible picture %s", async (_case, hiding, expectedPictures) => {
    const diagnostic = hiding === "diagnostic" || hiding === "diagnostic-race";
    const page = await openViewer({connected:true,diagnosticTiles:diagnostic});
    try {
      const stages: string[] = [];
      page.on("console", message => {
        const prefix = "[ConnectionTiming] ";
        if (message.text().startsWith(prefix)) stages.push(JSON.parse(message.text().slice(prefix.length)).stage);
      });
      await page.locator(".table-row").filter({hasText:"PC-0"}).getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      const tabHidden = hiding === "tab";
      if (tabHidden) await page.getByRole("button",{name:"장비 목록",exact:true}).click();
      else await page.evaluate(() => {
        Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.evaluate(() => {
        const w = window as any;
        w.timingFixtureFrame = (sequence:number,color:string) => {
          const source = document.createElement("canvas");
          source.width = source.height = 32;
          const ctx = source.getContext("2d")!;
          ctx.fillStyle = color; ctx.fillRect(0,0,32,32);
          return {sequence,keyframe:true,width:32,height:32,
            tiles:[{x:0,y:0,w:32,h:32,data:source.toDataURL("image/jpeg").split(",")[1]}]};
        };
        w.rtcCallbacks.onFrame(w.timingFixtureFrame(1,"#ff0000"));
      });
      const canvas = page.locator(".remote-canvas");
      await expect.poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).width)).toBe(32);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(stages).toContain("frame-received");
      expect(stages).not.toContain("first-picture");
      if (hiding === "diagnostic-race") {
        await page.evaluate(() => {
          const w = window as any;
          const native = window.Image;
          w.Image = function() {
            window.Image = native;
            const img = new native();
            Object.defineProperty(img,"onload",{set(callback) {
              img.addEventListener("load",() => { w.releaseDiagnosticFrame = () => callback.call(img); },{once:true});
            }});
            return img;
          };
          w.nextDiagnosticFrame = w.timingFixtureFrame(2,"#0000ff");
        });
        await page.waitForFunction(() => typeof (window as any).releaseDiagnosticFrame === "function");
        await page.evaluate(() => {
          const w = window as any;
          w.rtcCallbacks.onFrame(w.timingFixtureFrame(3,"#00ff00"));
        });
      }
      if (hiding === "disconnected" || diagnostic) {
        await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error("fixture disconnected")));
      }
      if (hiding === "diagnostic-race") {
        await page.evaluate(() => (window as any).releaseDiagnosticFrame());
        await page.clock.runFor(100);
        expect(stages).not.toContain("first-picture");
      }

      const before = await counts(page);
      if (tabHidden) {
        expect(await canvas.isVisible()).toBe(false);
        await page.getByRole("button",{name:"PC-0",exact:true}).click();
      } else if (hiding === "closed") {
        const scheduled = await page.evaluate(() => {
          const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
          const heldId = -1;
          let scheduled = false;
          window.requestAnimationFrame = () => { scheduled = true; return heldId; };
          window.cancelAnimationFrame = id => {
            if (id !== heldId) { cancel(id); return; }
            (window as any).cancelledReveal = true;
            window.cancelAnimationFrame = cancel;
          };
          Reflect.deleteProperty(document,"visibilityState");
          try { document.dispatchEvent(new Event("visibilitychange")); }
          finally { window.requestAnimationFrame = request; }
          return scheduled;
        });
        expect(scheduled).toBe(true);
        await page.getByTestId("end-session").click();
        await canvas.waitFor({state:"detached"});
        expect(await page.evaluate(() => (window as any).cancelledReveal)).toBe(true);
      } else await page.evaluate(() => {
        Reflect.deleteProperty(document,"visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      if (hiding === "diagnostic") {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(stages).not.toContain("first-picture");
        await page.evaluate(() => {
          const w = window as any;
          w.nextDiagnosticFrame = w.timingFixtureFrame(2,"#0000ff");
        });
      }
      if (expectedPictures) {
        await expect.poll(() => stages.filter(stage => stage === "first-picture").length).toBe(expectedPictures);
        expect(stages.indexOf("first-picture")).toBeGreaterThan(stages.indexOf("frame-received"));
        const channel = diagnostic ? 2 : 0;
        expect(await canvas.evaluate((el,c) => (el as HTMLCanvasElement).getContext("2d")!.getImageData(15,15,1,1).data[c],channel)).toBeGreaterThan(240);
      }
      expect(await counts(page)).toEqual(before);
      expect(await page.evaluate(() => (window as any).testState.rtcStarts)).toBe(1);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(stages.filter(stage => stage === "first-picture")).toHaveLength(expectedPictures);
      if (hiding === "disconnected") expect(stages).toContain("failed");
    } finally { await page.close(); }
  });

  it.each([false, true])("uses actual remote cursor metadata only after painting (mobile=%s)", async mobile => {
    const page = await openViewer({connected:true, mobile});
    try {
      const stages: Array<{stage:string; elapsedMs:number}> = [];
      page.on('console', message => {
        const prefix='[ConnectionTiming] ';
        if (message.text().startsWith(prefix)) stages.push(JSON.parse(message.text().slice(prefix.length)));
      });
      const connect = () => page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await connect();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === 'function');
      const canvas = page.locator('.remote-canvas');
      expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).not.toBe('none');
      if (mobile) expect(await page.getByLabel('원격 포인터',{exact:true}).count()).toBe(1);
      const before = await counts(page);
      await page.evaluate(() => {
        const source=document.createElement('canvas'); source.width=64; source.height=32;
        const ctx=source.getContext('2d')!; ctx.fillStyle='#167d83'; ctx.fillRect(0,0,64,32);
        ctx.fillStyle='white'; ctx.fillRect(12,8,3,16);
        const data=source.toDataURL('image/jpeg').split(',')[1];
        (window as any).cursorFrame=(flag:unknown,sequence:number,keyframe=true,invalid=false)=>(window as any).rtcCallbacks.onFrame({cursorEmbedded:flag,sequence,keyframe,width:64,height:32,tiles:[{x:0,y:0,w:64,h:32,data:invalid?'invalid':data}]});
        (window as any).cursorFrame(true,1,true,true);
      });
      const status=page.getByTestId(mobile?'mobile-connection-status':'remote-connection-status');
      await status.getByText(/화면 표시 오류/).waitFor();
      expect(stages.map(stage=>stage.stage)).not.toContain('first-picture');
      expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).not.toBe('none');
      await page.evaluate(() => (window as any).cursorFrame(true,10));
      await expect.poll(() => canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      await expect.poll(() => stages.some(stage=>stage.stage==='first-picture')).toBe(true);
      const firstPicture=stages.findIndex(stage=>stage.stage==='first-picture');
      const frameReceived=stages.findIndex(stage=>stage.stage==='frame-received');
      expect(frameReceived).toBeGreaterThan(0);
      expect(firstPicture).toBeGreaterThan(frameReceived);
      expect(stages[firstPicture].elapsedMs).toBeGreaterThanOrEqual(stages[frameReceived].elapsedMs);
      if (mobile) expect(await page.getByLabel('원격 포인터',{exact:true}).count()).toBe(0);
      else {
        await page.getByTestId('secondary-tools').locator('summary').click();
        await page.getByRole('button',{name:'포인터 켜기',exact:true}).click();
        expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('crosshair');
        await page.getByTestId('secondary-tools').locator('summary').click();
        await page.getByRole('button',{name:'포인터 끄기',exact:true}).click();
        expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      }
      expect(await canvas.evaluate(e => (e as HTMLCanvasElement).getContext('2d')!.getImageData(13,12,1,1).data[0])).toBeGreaterThan(210);
      const original=await canvas.boundingBox();
      await page.getByRole('button',{name:mobile?'확대':'화면 확대',exact:true}).click();
      await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(original!.width);
      expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      await page.screenshot({path:`../.codex-tmp/actual-remote-cursor-${mobile?'mobile':'desktop'}.png`});
      await page.evaluate(() => (window as any).cursorFrame(undefined,9,false));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      await page.evaluate(() => (window as any).cursorFrame(false,11,true,true));
      await status.getByText(/화면 표시 오류/).waitFor();
      expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      await page.evaluate(() => (window as any).cursorFrame(undefined,12));
      await expect.poll(() => canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('default');
      if (mobile) expect(await page.getByLabel('원격 포인터',{exact:true}).count()).toBe(1);
      expect(await counts(page)).toEqual(before);
      await page.evaluate(() => (window as any).cursorFrame(true,14));
      await expect.poll(() => canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      const starts = await page.evaluate(() => (window as any).testState.rtcStarts);
      await page.evaluate(() => { (window as any).previousConnection = (window as any).rtcCallbacks; });
      if (mobile) await page.getByRole('button',{name:'화면 및 세션 설정',exact:true}).click();
      await page.getByTestId('end-session').click(); await connect();
      expect(await page.locator('.remote-canvas').evaluate(e => getComputedStyle(e).cursor)).not.toBe('none');
      await page.waitForFunction(previous => (window as any).testState.rtcStarts > previous, starts);
      await page.evaluate(() => (window as any).cursorFrame(true,1));
      await expect.poll(() => canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      await page.evaluate(() => {
        (window as any).previousConnection.onFrame({sequence:30, keyframe:true, width:96, height:32, cursorEmbedded:false, tiles:[]});
      });
      expect(await canvas.evaluate(e => getComputedStyle(e).cursor)).toBe('none');
      expect(await status.getByText(/화면 표시 오류/).count()).toBe(0);
    } finally { await page.close(); }
  });
  it.each([1024,1920,2560])("fits below the expanded fullscreen toolbar, centers zoom and places closable PC tabs in the header at %ipx",async(width)=>{
    const page=await openViewer({connected:true,desktop:true,viewport:{width,height:1440}});
    try{
      const connect=(name:string)=>page.locator('.table-row').filter({has:page.getByText(name,{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await connect('PC-0');
      const panel=page.locator('.session-panel:not(.session-panel-inactive)');
      const tabs=panel.getByRole('navigation',{name:'열린 원격 세션',exact:true});
      await tabs.getByRole('button',{name:'PC-0',exact:true}).waitFor();
      expect(await tabs.evaluate(e=>Boolean(e.closest('[data-testid="remote-command-bar"]')))).toBe(true);
      const order=await panel.locator('.session-command-actions').evaluate(e=>[...e.querySelectorAll('button[aria-label]')].map(b=>b.getAttribute('aria-label')));
      expect(order.indexOf('클립보드 동기화: 내 PC → 원격 PC')).toBeLessThan(order.indexOf('원격 클립보드 열기 (Win+V)'));
      await panel.locator('button[title="전체화면 전환"]').click();
      expect(await panel.getByTestId('fullscreen-toolbar-toggle').getAttribute('aria-expanded')).toBe('true');
      await page.evaluate(()=>{
        const source=document.createElement('canvas');source.width=1920;source.height=1200;
        source.getContext('2d')!.fillStyle='#157d84';source.getContext('2d')!.fillRect(0,0,1920,1200);
        (window as any).rtcCallbacks.onFrame({keyframe:true,width:1920,height:1200,tiles:[{x:0,y:0,w:1920,h:1200,data:source.toDataURL('image/jpeg').split(',')[1]}]});
      });
      await expect.poll(()=>panel.locator('.remote-canvas').evaluate(e=>(e as HTMLCanvasElement).width)).toBe(1920);
      const geometry=()=>panel.evaluate(e=>{
        const bar=e.querySelector('[data-testid="remote-command-bar"]')!.getBoundingClientRect();
        const viewport=e.querySelector('.remote-preview')!.getBoundingClientRect();
        const canvas=e.querySelector('.remote-canvas')!.getBoundingClientRect();
        return {barBottom:bar.bottom,viewTop:viewport.top,viewWidth:viewport.width,viewHeight:viewport.height,cx:canvas.x+canvas.width/2,cy:canvas.y+canvas.height/2,vx:viewport.x+viewport.width/2,vy:viewport.y+viewport.height/2,cw:canvas.width,ch:canvas.height};
      });
      await panel.getByRole('button',{name:'Fit',exact:true}).click();
      const fit=await geometry();expect(fit.viewTop).toBeGreaterThanOrEqual(fit.barBottom-1);
      expect(fit.cw/fit.ch).toBeCloseTo(1.6,2);expect(Math.min(fit.viewWidth-fit.cw,fit.viewHeight-fit.ch)).toBeLessThan(2);
      expect(Math.abs(fit.cx-fit.vx)).toBeLessThan(1);expect(Math.abs(fit.cy-fit.vy)).toBeLessThan(1);
      await panel.getByRole('button',{name:'화면 확대',exact:true}).click();const zoom=await geometry();
      expect(zoom.cw).toBeGreaterThan(fit.cw);expect(Math.abs(zoom.cx-zoom.vx)).toBeLessThan(1);expect(Math.abs(zoom.cy-zoom.vy)).toBeLessThan(1);
      expect(await panel.locator('.remote-canvas').evaluate(e=>(e as HTMLCanvasElement).getContext('2d')!.getImageData(1,1,1,1).data[3])).toBe(255);
      await page.screenshot({path:`../.codex-tmp/fullscreen-header-${width}.png`});
      await panel.getByRole('button',{name:'장비 목록',exact:true}).click();await connect('PC-1');
      const active=page.locator('.session-panel:not(.session-panel-inactive)');
      const activeTabs=active.getByRole('navigation',{name:'열린 원격 세션',exact:true});
      await activeTabs.getByRole('button',{name:'PC-0 세션 닫기',exact:true}).click();
      await expect.poll(()=>page.evaluate(()=>(window as any).testState.closedSessions)).toEqual(['remote-session-device-0-1']);
      await activeTabs.getByRole('button',{name:'PC-1',exact:true}).waitFor();
    }finally{await page.close();}
  });
  it("tracks a requested Agent update per device without duplicate sends, refresh clicks or stale-success claims",async()=>{
    const page=await openViewer({desktop:true});
    try{
      const row=page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})});
      const update=row.getByRole('button',{name:'에이전트 업데이트 요청',exact:true});
      await update.click();await update.click();
      await page.getByText('PC-0: Agent 응답 대기 중',{exact:true}).waitFor();
      expect(await page.evaluate(()=>(window as any).updateRequests.length)).toBe(1);
      await page.evaluate(()=>{const w=window as any,d=w.testState.devices[0];w.updateWatchers[d.id].next({...d,updateState:'healthy',version:'0.1.115'});});
      await page.getByText('PC-0: Agent 응답 대기 중',{exact:true}).waitFor();
      await page.evaluate(()=>{const w=window as any,d=w.testState.devices[0];w.updateWatchers[d.id].next({...d,updateRequestId:w.updateRequests[0].requestId,updateState:'downloading',updateProgress:70});});
      await page.getByText('PC-0: 다운로드 중 70%',{exact:true}).waitFor();
      await page.evaluate(()=>{const w=window as any,d=w.testState.devices[0];w.updateWatchers[d.id].next({...d,updateRequestId:w.updateRequests[0].requestId,updateState:'healthy',version:'0.1.116'});});
      await page.getByText('PC-0: 업데이트 완료 v0.1.116 · Agent 재실행 확인',{exact:true}).waitFor();
      expect(await page.evaluate(()=>(window as any).updateWatchStops)).toEqual(['device-0']);
      await page.clock.fastForward(86_400_000);expect(await page.evaluate(()=>(window as any).updateRequests.length)).toBe(1);
      await row.getByRole('button',{name:'에이전트 업데이트 요청',exact:true}).click();
      await page.getByRole('button',{name:'로그아웃',exact:true}).click();
      expect(await page.evaluate(()=>(window as any).updateWatchStops)).toEqual(['device-0','device-0']);
    }finally{await page.close();}
  });
  it("shows Caps Lock and Korean/English state, preserves the password on reveal and never submits IME composition", async () => {
    const page=await openViewer({authenticated:false,desktop:true,viewport:{width:320,height:740}});
    try {
      const password=page.locator('input[name="password"]');
      await password.fill("offline-test-password");
      await page.getByText("입력: 영문",{exact:true}).waitFor();
      await page.evaluate(()=>{
        const w=window as any;w.loginAttempts=0;
        w.testApi.loginViewerWithFirebase=async()=>{w.loginAttempts++;};
        w.loginInputState={capsLock:true,inputMode:"ko"};
        const event=new KeyboardEvent('keyup',{key:'HangulMode',code:'Lang1',bubbles:true});
        Object.defineProperty(event,'getModifierState',{value:(key:string)=>key==='CapsLock'});
        document.querySelector('input[name="password"]')!.dispatchEvent(event);
      });
      await page.getByText("Caps Lock: 켜짐",{exact:true}).waitFor();
      await page.getByText("입력: 한글",{exact:true}).waitFor();
      await page.getByRole('button',{name:'비밀번호 표시',exact:true}).click();
      expect(await password.getAttribute('type')).toBe('text');
      expect(await password.inputValue()).toBe('offline-test-password');
      expect(await password.evaluate(e=>e===document.activeElement)).toBe(true);
      await page.getByRole('button',{name:'비밀번호 숨기기',exact:true}).click();
      expect(await password.evaluate(input=>{
        input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        const enter=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});
        const accepted=input.dispatchEvent(enter);
        (input.closest('form') as HTMLFormElement).requestSubmit();
        return accepted;
      })).toBe(false);
      expect(await page.evaluate(()=>(window as any).loginAttempts)).toBe(0);
      await password.evaluate(input=>input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
      expect(await password.evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true})))).toBe(false);
      expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage,(window as any).nativeCalls]))).not.toContain('offline-test-password');
      expect(await page.locator('.login-panel').evaluate(e=>e.getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:'../.codex-tmp/login-input-mobile.png'});
    } finally {await page.close();}
  });
  it("sends only one login during repeated submission and explains rate limits without a fake countdown", async () => {
    const page=await openViewer({authenticated:false,desktop:true});
    try {
      await page.locator('input[name="username"]').fill('offline@example.test');
      await page.locator('input[name="password"]').fill('offline-test-password');
      await page.evaluate(()=>{
        const w=window as any;w.loginAttempts=0;
        w.testApi.loginViewerWithFirebase=async()=>{
          w.loginAttempts++;await new Promise<void>((_resolve,reject)=>{w.rejectLogin=reject;});
        };
      });
      await page.locator('.login-panel').evaluate(form=>{(form as HTMLFormElement).requestSubmit();(form as HTMLFormElement).requestSubmit();});
      await page.getByRole('button',{name:'로그인 중',exact:true}).waitFor();
      expect(await page.getByRole('button',{name:'로그인 중',exact:true}).isDisabled()).toBe(true);
      expect(await page.evaluate(()=>(window as any).loginAttempts)).toBe(1);
      await page.evaluate(()=>{(window as any).rejectLogin(new Error('로그인 시도가 너무 많아 이 기기의 로그인 요청이 일시 제한되었습니다. 인증 서버가 해제 시각이나 남은 시간을 제공하지 않아 정확한 대기 시간을 표시할 수 없습니다. 반복 시도를 멈추고 나중에 다시 시도해 주세요.'));});
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').textContent()).toContain('정확한 대기 시간을 표시할 수 없습니다');
      expect(await page.getByRole('button',{name:'로그인',exact:true}).isEnabled()).toBe(true);
      await page.clock.fastForward(86_400_000);
      expect(await page.evaluate(()=>(window as any).loginAttempts)).toBe(1);
      for(const width of [1440,320]){
        await page.setViewportSize({width,height:900});
        expect(await page.getByRole('alert').evaluate(e=>e.getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      }
      await page.screenshot({path:'../.codex-tmp/login-rate-limit-mobile.png'});
    } finally {await page.close();}
  });
  it("bounds native input queries, ignores stale replies and removes listeners on login unmount", async () => {
    const page=await openViewer({authenticated:false,desktop:true});
    try {
      await page.getByText('입력: 영문',{exact:true}).waitFor();
      const queryCount=()=>page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='get_login_input_state').length);
      const before=await queryCount();
      await page.clock.fastForward(86_400_000);
      expect(await queryCount()).toBe(before);
      await page.evaluate(()=>{(window as any).deferInputState=true;window.dispatchEvent(new Event('focus'));});
      await page.waitForFunction(()=>typeof (window as any).finishInputState==='function');
      await page.evaluate(()=>{
        const w=window as any;w.deferInputState=false;w.loginInputState={capsLock:null,inputMode:'unknown'};
        for(let i=0;i<8;i++)window.dispatchEvent(new Event('focus'));
        w.finishInputState({capsLock:true,inputMode:'ko'});
      });
      await page.getByText('입력: 확인 불가',{exact:true}).waitFor();
      expect(await page.getByText('Caps Lock: 확인 전',{exact:true}).count()).toBe(1);
      expect(await queryCount()).toBe(before+2);
      await page.evaluate(()=>{(window as any).deferInputState=true;window.dispatchEvent(new Event('focus'));});
      await page.evaluate(()=>{const w=window as any;w.root.unmount();w.finishInputState({capsLock:true,inputMode:'ko'});window.dispatchEvent(new Event('focus'));});
      await page.clock.fastForward(86_400_000);
      expect(await queryCount()).toBe(before+3);
      expect(await page.locator('#root').textContent()).toBe('');
    } finally {await page.close();}
  });
  it.each([15, 60, 180, 480, 720])("remembers this Viewer's unlock for exactly %s minutes without renewing or persisting passwords", async (minutes) => {
    const page = await openViewer({connected:true,desktop:true,viewport:minutes===720?{width:390,height:844}:undefined});
    try {
      await page.evaluate(() => {
        const w=window as any;
        w.testState.devices[0].accessLocked=true;w.testState.devices[0].accessLockVersion='version-1';
        const original=w.testApi.openFirebaseSession;w.unlockAttempts=[];
        w.testApi.openFirebaseSession=(...args:any[])=>{w.unlockAttempts.push(args[3]);return original(...args);};
      });
      await refresh(page).click();
      const row=page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})});
      const connect=async()=>{await row.getByRole('button',{name:'접속',exact:true}).click();};
      const disconnect=async()=>{await page.getByRole('button',{name:'세션 종료',exact:true}).click();await refresh(page).waitFor();};
      await connect();
      const dialog=page.getByRole('dialog',{name:'잠금 장비 접속'});
      expect(await dialog.getByLabel('이 PC의 잠금 해제 유지시간').locator('option').allTextContents()).toEqual(['15분간','1시간','3시간','8시간','12시간']);
      expect(await dialog.getByLabel('접속 비밀번호',{exact:true}).evaluate(e=>e===document.activeElement)).toBe(true);
      await dialog.getByLabel('이 PC의 잠금 해제 유지시간').selectOption(String(minutes));
      if(minutes===15){
        await dialog.getByLabel('이 PC의 잠금 해제 유지시간').focus();await page.keyboard.press('Tab');
        expect(await dialog.getByRole('button',{name:'접속',exact:true}).evaluate(e=>e===document.activeElement)).toBe(true);
        await page.keyboard.press('Tab');
        expect(await dialog.getByRole('button',{name:'잠금 창 닫기'}).evaluate(e=>e===document.activeElement)).toBe(true);
      }
      await dialog.getByLabel('접속 비밀번호',{exact:true}).fill('remembered-test-password');
      await page.screenshot({path:`../.codex-tmp/unlock-duration-${minutes}.png`});
      expect(await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})).toBe(true);
      if (minutes===720) await page.setViewportSize({width:1440,height:900});
      if (minutes===15) await dialog.locator('form').evaluate(form=>{(form as HTMLFormElement).requestSubmit();(form as HTMLFormElement).requestSubmit();});
      else await dialog.getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('button',{name:'세션 종료',exact:true}).waitFor();
      await disconnect();
      await page.clock.fastForward(minutes*60_000-10_000);
      await connect();
      await page.getByRole('button',{name:'세션 종료',exact:true}).waitFor();
      expect(await dialog.count()).toBe(0);
      expect(await page.evaluate(()=>(window as any).unlockAttempts)).toEqual(['remembered-test-password','remembered-test-password']);
      await disconnect();
      const before=await counts(page);
      await page.clock.fastForward(11_000);
      expect(await counts(page)).toEqual(before);
      await connect();await dialog.waitFor();
      expect(await dialog.getByLabel('접속 비밀번호',{exact:true}).inputValue()).toBe('');
      expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain('remembered-test-password');
      await page.getByRole('button',{name:'잠금 창 닫기'}).click();
      expect(await page.evaluate(()=>(window as any).unlockAttempts)).toHaveLength(2);
    } finally {await page.close();}
  });
  it("isolates remembered unlock by device, Viewer and lock version", async () => {
    const page=await openViewer({connected:true,desktop:true});
    try {
      await page.evaluate(()=>{const w=window as any;for(const device of w.testState.devices.slice(0,2)){device.accessLocked=true;device.accessLockVersion='version-1';}});
      await refresh(page).click();
      const row=(name:string)=>page.locator('.table-row').filter({has:page.getByText(name,{exact:true})});
      await row('PC-0').getByRole('button',{name:'접속',exact:true}).click();
      await page.getByLabel('접속 비밀번호',{exact:true}).fill('password');
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('button',{name:'세션 종료',exact:true}).click();
      await row('PC-1').getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();
      expect(await page.getByLabel('접속 비밀번호',{exact:true}).inputValue()).toBe('');
      await page.getByRole('button',{name:'잠금 창 닫기'}).click();
      await page.evaluate(()=>{(window as any).testState.devices[0].accessLockVersion='version-2';});
      await refresh(page).click();
      await row('PC-0').getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();
      expect(await page.getByLabel('접속 비밀번호',{exact:true}).inputValue()).toBe('');
      await page.getByRole('button',{name:'잠금 창 닫기'}).click();
      await row('PC-0').getByRole('button',{name:'접속',exact:true}).click();
      await page.getByLabel('접속 비밀번호',{exact:true}).fill('new-password');
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('button',{name:'세션 종료',exact:true}).click();
      await page.evaluate(()=>(window as any).root.unmount());
      await page.addScriptTag({content:bundle});
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(()=>{const w=window as any;w.testState.devices[0].accessLocked=true;w.testState.devices[0].accessLockVersion='version-2';});
      await refresh(page).click();
      await row('PC-0').getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();
      expect(await page.getByLabel('접속 비밀번호',{exact:true}).inputValue()).toBe('');
    } finally {await page.close();}
  });
  it("never remembers failed authentication and clears owned expiry timers on logout and unmount", async () => {
    const page=await openViewer({connected:true,desktop:true});
    try {
      await page.evaluate(()=>{
        const w=window as any;w.testState.devices[0].accessLocked=true;w.testState.devices[0].accessLockVersion='version-1';
        const original=w.testApi.openFirebaseSession;w.unlockAttempts=[];w.unlockFailure=true;w.unlockTimers=new Set();
        w.testApi.openFirebaseSession=(...args:any[])=>{w.unlockAttempts.push(args[3]);if(w.unlockFailure)throw Error('Password rejected');return original(...args);};
        const schedule=w.setTimeout.bind(w),cancel=w.clearTimeout.bind(w);
        w.setTimeout=(fn:any,delay:number,...args:any[])=>{const id=schedule(fn,delay,...args);if(delay===900_000)w.unlockTimers.add(id);return id;};
        w.clearTimeout=(id:number)=>{w.unlockTimers.delete(id);cancel(id);};
      });
      await refresh(page).click();
      const connect=()=>page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const submit=async()=>{await page.getByLabel('접속 비밀번호',{exact:true}).fill('password');await page.getByRole('dialog',{name:'잠금 장비 접속'}).getByRole('button',{name:'접속',exact:true}).click();};
      await connect();await submit();
      await page.getByText('Password rejected',{exact:true}).waitFor();
      expect(await page.evaluate(()=>(window as any).unlockTimers.size)).toBe(0);
      await connect();await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();
      await page.evaluate(()=>{(window as any).unlockFailure=false;});await submit();
      await page.getByRole('button',{name:'세션 종료',exact:true}).click();
      expect(await page.evaluate(()=>(window as any).unlockTimers.size)).toBe(1);
      await page.evaluate(()=>{(window as any).unlockFailure=true;});await connect();
      await expect.poll(()=>page.evaluate(()=>(window as any).unlockAttempts.length)).toBe(3);
      expect(await page.evaluate(()=>(window as any).unlockTimers.size)).toBe(0);
      await connect();await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();
      await page.evaluate(()=>{(window as any).unlockFailure=false;});await submit();
      await page.getByRole('button',{name:'세션 종료',exact:true}).click();
      await page.getByRole('button',{name:'로그아웃',exact:true}).click();
      await page.getByRole('button',{name:'로그인',exact:true}).waitFor();
      await expect.poll(()=>page.evaluate(()=>(window as any).unlockTimers.size)).toBe(0);
      await page.evaluate(()=>{const w=window as any;w.testApi.loginViewerWithFirebase=async()=>w.authChanged(true);});
      await page.locator('input[name="username"]').fill('test');
      await page.locator('input[name="password"]').fill('test');
      await page.getByRole('button',{name:'로그인',exact:true}).click();
      await page.getByText('PC-0',{exact:true}).waitFor();await connect();
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();await submit();
      await page.getByRole('button',{name:'세션 종료',exact:true}).waitFor();
      expect(await page.evaluate(()=>(window as any).unlockTimers.size)).toBe(1);
      const before=await page.evaluate(()=>(window as any).unlockAttempts.length);
      await page.evaluate(()=>(window as any).root.unmount());
      expect(await page.evaluate(()=>(window as any).unlockTimers.size)).toBe(0);
      await page.clock.fastForward(43_200_000);
      expect(await page.evaluate(()=>(window as any).unlockAttempts.length)).toBe(before);
    } finally {await page.close();}
  });
  it("cleans up late authorization after unmount without an offer or remembered unlock", async () => {
    const page=await openViewer({connected:true,desktop:true});
    try {
      await page.evaluate(()=>{
        const w=window as any;w.testState.devices[0].accessLocked=true;w.testState.devices[0].accessLockVersion='version-1';
        const original=w.testApi.openFirebaseSession;w.rememberSchedules=0;w.queuedOffers=[];
        w.testApi.queuePreparedFirebaseViewerOffer=(id:string)=>w.queuedOffers.push(id);
        w.testApi.openFirebaseSession=async(...args:any[])=>{await new Promise(resolve=>{w.finishAuthorization=resolve;});const result=await original(...args);w.authorizationDone=true;return result;};
        const schedule=w.setTimeout.bind(w);
        w.setTimeout=(fn:any,delay:number,...args:any[])=>{if(delay===900_000)w.rememberSchedules++;return schedule(fn,delay,...args);};
      });
      await refresh(page).click();
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.getByLabel('접속 비밀번호',{exact:true}).fill('password');
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).getByRole('button',{name:'접속',exact:true}).click();
      await page.waitForFunction(()=>(window as any).finishAuthorization);
      await page.evaluate(()=>(window as any).root.unmount());
      await page.evaluate(()=>(window as any).finishAuthorization());
      await expect.poll(() => page.evaluate(() => {
        const w = window as any;
        return {closed:w.testState.closedSessions, offers:w.queuedOffers, remembered:w.rememberSchedules};
      })).toEqual({closed:["remote-session-device-0-1"],offers:[],remembered:0});
    } finally {await page.close();}
  });
  it("device access lock modal blocks connection until password and supports settings/reset with no idle requests", async () => {
    const page = await openViewer({connected:true, desktop:true});
    try {
      const stages: Array<{attempt: number; stage: string; elapsedMs: number}> = [];
      page.on('console', message => {
        const prefix = '[ConnectionTiming] ';
        if (message.text().startsWith(prefix)) stages.push(JSON.parse(message.text().slice(prefix.length)));
      });
      await page.evaluate(() => {
        const w = window as any;
        w.testState.devices[0].accessLocked = true;
        w.testState.devices[0].accessLockVersion = "version-1";
        w.testState.devices[0].accessPublicKey = "A".repeat(392);
        const original = w.testApi.openFirebaseSession;
        w.testApi.openFirebaseSession = (...args: any[]) => { w.enteredPassword = args[3]; return original(...args); };
        w.accessCalls = [];
        w.testApi.requestFirebaseDeviceAccess = async (...args: any[]) => {
          w.accessCalls.push(args.slice(0, 3));
          if (w.accessFailure) throw Error("Agent rejected password");
          return {requestId:"request-1", version:"version-2"};
        };
      });
      await refresh(page).click();
      const row = page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})});
      await row.getByRole('button',{name:'접속',exact:true}).click();
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).waitFor();
      expect(await page.evaluate(()=>(window as any).testState.connections)).toEqual([]);
      await page.getByRole('button',{name:'잠금 창 닫기'}).click();
      expect(await page.evaluate(()=>(window as any).testState.connections)).toEqual([]);
      await expect.poll(() => stages.map(event=>event.stage)).toEqual(['connect-click','cancelled']);
      await row.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      await page.getByRole('button',{name:'접속 잠금',exact:true}).click();
      await page.getByRole('button',{name:'비밀번호 분실',exact:true}).click();
      const admin = page.getByLabel('관리자 비밀번호',{exact:true});
      expect(await admin.getAttribute('type')).toBe('password');
      await admin.fill('test admin');
      await page.getByLabel('새 비밀번호',{exact:true}).fill('new-password');
      await page.getByLabel('새 비밀번호 확인',{exact:true}).fill('not-the-same');
      await page.screenshot({path:'../.codex-tmp/device-access-lock-modal.png'});
      await page.getByRole('button',{name:'재설정',exact:true}).click();
      expect(await page.evaluate(()=>(window as any).accessCalls)).toEqual([]);
      await page.getByLabel('새 비밀번호 확인',{exact:true}).fill('new-password');
      await page.evaluate(()=>{(window as any).accessFailure=true;});
      await page.getByRole('button',{name:'재설정',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'Agent rejected password'}).waitFor();
      expect(await page.getByLabel('새 비밀번호',{exact:true}).inputValue()).toBe('new-password');
      await page.evaluate(()=>{(window as any).accessFailure=false;});
      await page.getByRole('button',{name:'재설정',exact:true}).click();
      await expect.poll(()=>page.getByRole('dialog',{name:'접속 비밀번호 재설정'}).count()).toBe(0);
      expect(await page.evaluate(()=>(window as any).accessCalls.map((call:any[])=>call.slice(0,2)))).toEqual([['device-0','reset'],['device-0','reset']]);
      await row.getByRole('button',{name:'접속',exact:true}).click();
      await page.getByLabel('접속 비밀번호',{exact:true}).fill('new-password');
      await page.clock.runFor(2_000);
      expect(stages.some(event=>event.stage==='connect-request')).toBe(false);
      await page.getByRole('dialog',{name:'잠금 장비 접속'}).getByRole('button',{name:'접속',exact:true}).click();
      await expect.poll(()=>page.evaluate(()=>(window as any).testState.connections)).toEqual(['device-0']);
      await expect.poll(() => stages.some(event=>event.stage==='session-ready')).toBe(true);
      const request = stages.find(event=>event.stage==='connect-request')!;
      expect(request.attempt).not.toBe(stages[0].attempt);
      expect(stages.filter(event=>event.attempt===request.attempt).slice(0,3).map(event=>event.stage)).toEqual(['connect-click','connect-request','session-ready']);
      expect(request.elapsedMs).toBeGreaterThanOrEqual(2_000);
      expect(JSON.stringify(stages)).not.toContain('new-password');
      expect(await page.evaluate(()=>(window as any).enteredPassword)).toBe('new-password');
      expect(await page.locator('input[type=password]').count()).toBe(0);
      await page.screenshot({path:'../.codex-tmp/device-access-lock-browser.png'});
    } finally {await page.close();}
  });
  it("running Agent metadata editor saves without restart, preserves failed drafts and has no idle requests", async () => {
    const page=await openViewer({desktop:true,agent:true,viewport:{width:360,height:420}});
    try {
      await page.getByRole('heading',{name:'Agent 가동 중',exact:true}).waitFor();
      await page.evaluate(()=>{
        const w=window as any;w.metadataLoads=0;w.metadataSaves=[];
        w.metadataDevice={id:'123-45-67890:AGENT-0',businessNumber:'123-45-67890',storeName:'현재 매장',deviceName:'메인포스'};
        w.testApi.fetchFirebaseAgentDevice=async()=>{w.metadataLoads++;return structuredClone(w.metadataDevice);};
        w.testApi.updateFirebaseAgentDevice=async(config:any,input:any)=>{
          w.metadataSaves.push({config,input});await new Promise<void>(resolve=>{w.finishMetadataSave=resolve;});
          if(w.metadataFailure)throw Error(w.metadataFailure);
          Object.assign(w.metadataDevice,input);return structuredClone(w.metadataDevice);
        };
      });
      await page.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      const passwordDialog=page.getByRole('dialog',{name:'장비 정보 수정 비밀번호',exact:true});
      await passwordDialog.waitFor();
      expect(await passwordDialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})).toBe(true);
      expect(await passwordDialog.getByLabel('비밀번호',{exact:true}).getAttribute('type')).toBe('password');
      expect(await passwordDialog.getByLabel('비밀번호',{exact:true}).evaluate(e=>e===document.activeElement)).toBe(true);
      await passwordDialog.getByLabel('비밀번호',{exact:true}).fill('1234');
      await passwordDialog.getByRole('button',{name:'확인',exact:true}).click();
      await passwordDialog.getByRole('alert').filter({hasText:'비밀번호가 일치하지 않습니다'}).waitFor();
      await page.screenshot({path:'../.codex-tmp/agent-metadata-password.png'});
      expect(await page.evaluate(()=>(window as any).metadataLoads)).toBe(0);
      expect(await page.getByRole('dialog',{name:'Agent 장비 정보 수정',exact:true}).count()).toBe(0);
      await passwordDialog.getByRole('button',{name:'취소',exact:true}).click();
      await page.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      expect(await passwordDialog.getByLabel('비밀번호',{exact:true}).inputValue()).toBe('');
      await passwordDialog.getByRole('button',{name:'확인',exact:true}).click();
      expect(await page.evaluate(()=>(window as any).metadataLoads)).toBe(0);
      await page.keyboard.press('Escape');
      expect(await passwordDialog.count()).toBe(0);
      await page.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      await passwordDialog.getByLabel('비밀번호',{exact:true}).fill('4401');
      await passwordDialog.getByRole('button',{name:'확인',exact:true}).evaluate(e=>{for(let i=0;i<3;i++)e.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
      const dialog=page.getByRole('dialog',{name:'Agent 장비 정보 수정',exact:true});
      await dialog.waitFor();expect(await dialog.getByLabel('상호',{exact:true}).inputValue()).toBe('현재 매장');
      expect(await page.evaluate(()=>(window as any).metadataLoads)).toBe(1);
      await dialog.getByLabel('상호',{exact:true}).fill('변경 매장');
      await dialog.getByLabel('사업자번호',{exact:true}).fill('123');
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await dialog.getByRole('alert').filter({hasText:'10자리'}).waitFor();
      expect(await page.evaluate(()=>(window as any).metadataSaves.length)).toBe(0);
      await dialog.getByLabel('사업자번호',{exact:true}).fill('9876543210');
      await dialog.getByLabel('장비 구분',{exact:true}).selectOption('키오스크');
      await page.screenshot({path:'../.codex-tmp/agent-live-metadata.png'});
      expect(await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})).toBe(true);
      expect(await dialog.getByRole('button',{name:'저장',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await dialog.getByRole('button',{name:'저장',exact:true}).evaluate(e=>{for(let i=0;i<3;i++)e.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
      await expect.poll(()=>page.evaluate(()=>(window as any).metadataSaves.length)).toBe(1);
      expect(await dialog.getByRole('button',{name:'취소',exact:true}).isDisabled()).toBe(true);
      await page.evaluate(()=>{const w=window as any;w.metadataFailure='permission-denied';w.finishMetadataSave();});
      await dialog.getByRole('alert').filter({hasText:'permission-denied'}).waitFor();
      expect(await dialog.evaluate(e=>e.querySelector('.agent-metadata-fields')!.getBoundingClientRect().bottom<=e.querySelector('[role="alert"]')!.getBoundingClientRect().top)).toBe(true);
      await page.screenshot({path:'../.codex-tmp/agent-live-metadata-failure.png'});
      expect(await dialog.getByLabel('상호',{exact:true}).inputValue()).toBe('변경 매장');
      await page.evaluate(()=>{(window as any).metadataFailure='';});
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await page.evaluate(()=>(window as any).finishMetadataSave());
      await page.getByRole('status').filter({hasText:'장비 정보를 저장'}).waitFor();
      expect(await dialog.count()).toBe(0);
      expect(await page.getByText('987-65-43210',{exact:true}).count()).toBe(1);
      expect(await page.getByText('123-45-67890:AGENT-0',{exact:true}).count()).toBe(1);
      const last=await page.evaluate(()=>(window as any).metadataSaves.at(-1));
      expect(last).toMatchObject({config:{registeredDeviceId:'123-45-67890:AGENT-0',installId:'test-agent'},input:{businessNumber:'987-65-43210',storeName:'변경 매장',deviceName:'키오스크'}});
      await page.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      await passwordDialog.waitFor();
      expect(await passwordDialog.getByLabel('비밀번호',{exact:true}).inputValue()).toBe('');
      expect(await dialog.count()).toBe(0);
      await passwordDialog.getByLabel('비밀번호',{exact:true}).fill('4401');
      await passwordDialog.getByRole('button',{name:'확인',exact:true}).click();
      await dialog.waitFor();expect(await dialog.getByLabel('장비 구분',{exact:true}).inputValue()).toBe('키오스크');
      await dialog.getByLabel('상호',{exact:true}).fill('취소할 변경');
      await dialog.getByRole('button',{name:'취소',exact:true}).click();
      const before=await page.evaluate(()=>({loads:(window as any).metadataLoads,saves:(window as any).metadataSaves.length}));
      await page.clock.runFor(86_400_000);
      expect(await page.evaluate(()=>({loads:(window as any).metadataLoads,saves:(window as any).metadataSaves.length}))).toEqual(before);
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>['save_agent_config','restart_agent_process'].includes(c.command)).length)).toBe(0);
    } finally {await page.close();}
  });
  it("running Agent editor ignores a late read after unmount and reports load failure", async () => {
    const page=await openViewer({desktop:true,agent:true});
    try {
      await page.getByRole('heading',{name:'Agent 가동 중',exact:true}).waitFor();
      await page.evaluate(()=>{const w=window as any;w.testApi.fetchFirebaseAgentDevice=async()=>{throw Error('장비 조회 실패');};});
      await page.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      await page.getByRole('dialog',{name:'장비 정보 수정 비밀번호',exact:true}).getByLabel('비밀번호',{exact:true}).fill('4401');
      await page.getByRole('dialog',{name:'장비 정보 수정 비밀번호',exact:true}).getByRole('button',{name:'확인',exact:true}).click();
      await page.getByText('장비 조회 실패',{exact:true}).waitFor();
      expect(await page.getByRole('dialog').count()).toBe(0);
      await page.evaluate(()=>{const w=window as any;w.testApi.fetchFirebaseAgentDevice=()=>new Promise(resolve=>{w.finishMetadataRead=resolve;});});
      await page.getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      await page.getByRole('dialog',{name:'장비 정보 수정 비밀번호',exact:true}).getByLabel('비밀번호',{exact:true}).fill('4401');
      await page.getByRole('dialog',{name:'장비 정보 수정 비밀번호',exact:true}).getByRole('button',{name:'확인',exact:true}).click();
      await page.evaluate(()=>{const w=window as any;w.root.unmount();w.finishMetadataRead({businessNumber:'123-45-67890',storeName:'late',deviceName:'메인포스'});});
      expect(await page.getByRole('dialog').count()).toBe(0);
    } finally {await page.close();}
  });
  it("initial registration metadata is usable in the compact Agent form and reaches the existing request", async () => {
    const page=await openViewer({desktop:true,agent:true,firstRun:true,viewport:{width:360,height:420}});
    try {
      await page.getByRole('heading',{name:'Agent 최초 실행',exact:true}).waitFor();
      await page.evaluate(()=>{const w=window as any;w.testApi.registerFirstRunAgentWithFirebase=async (input:any)=>{w.registrationInput=input;return {device:{id:'123-45-67890:AGENT-test-agent',businessNumber:'123-45-67890',...input},devices:[]};};});
      await page.getByLabel('아이디',{exact:true}).fill('1234567890');
      await page.getByLabel('비밀번호',{exact:true}).fill('1234');
      await page.getByLabel('상호',{exact:true}).fill('테스트 매장');
      await page.getByLabel('장비 구분',{exact:true}).selectOption('custom');
      await page.getByLabel('장비 구분 직접입력',{exact:true}).fill('키오스크');
      await page.getByLabel('메모',{exact:true}).fill('카운터 오른쪽\n설치 메모');
      expect(await page.getByRole('button',{name:'등록',exact:true}).evaluate(button=>{
        const r=button.getBoundingClientRect();return r.bottom<=innerHeight&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
      })).toBe(true);
      await page.screenshot({path:'../.codex-tmp/agent-initial-metadata.png'});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button',{name:'등록',exact:true}).click();
      await page.getByRole('heading',{name:'Agent 가동 중',exact:true}).waitFor();
      expect(await page.evaluate(()=>(window as any).registrationInput)).toMatchObject({storeName:'테스트 매장',deviceName:'키오스크',notes:'카운터 오른쪽\n설치 메모',installId:'test-agent'});
      expect(await page.locator('.agent-panel-footer').getByRole('button',{name:'ZOOK 대기',exact:true}).evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='save_agent_config').length)).toBe(1);
    } finally {await page.close();}
  });
  it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("shares Viewer group edits and store order live between independent same-account browsers", async () => {
    const address = process.env.FIRESTORE_EMULATOR_HOST!;
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Expected a loopback Firestore emulator.");
    const firestorePort = Number(address.split(":")[1]);
    const { wireBrowserToLocalFirestore } = await import("./firebase/browserFirestoreRtcFixture");
    const projectId = `demo-connect-${crypto.randomUUID().slice(0, 8)}`;
    const pages: Page[] = [];
    const open = (uid: string) => openViewer({ firestorePort, firestoreGroupingProject: projectId }, browser, async page => {
      pages.push(page);
      await page.evaluate(() => {
        const state = (window as any).testState;
        state.devices = state.devices.slice(0, 3);
        state.devices.forEach((device: ManagedDevice, index: number) => { device.storeName = index < 2 ? "Store A" : "Store B"; });
      });
      await wireBrowserToLocalFirestore(page, projectId, uid, firestorePort, false, true);
    });
    try {
      const a = await open("group-test-shared");
      const b = await open("group-test-shared");
      const isolated = await open("group-test-other");
      for (const page of pages) await expect.poll(() => page.getByRole("button", { name: "대그룹 생성", exact: true }).isEnabled()).toBe(true);
      const editGroup = (page: Page, name: string) => page.getByRole("button", { name: `${name} 그룹 수정`, exact: true });
      await a.getByRole("button", { name: "대그룹 생성", exact: true }).click();
      let editor = a.getByRole("dialog", { name: "그룹 편집", exact: true });
      await editor.getByLabel("그룹 이름", { exact: true }).fill("공유 시험 그룹");
      await editor.getByRole("checkbox", { name: /PC-0/ }).check();
      await editor.getByRole("button", { name: "저장", exact: true }).click();
      await editor.waitFor({ state: "hidden" });
      await editGroup(b, "공유 시험 그룹").waitFor();
      await b.getByRole("region", { name: "사용자 그룹", exact: true }).locator(".group-button").filter({ hasText: "공유 시험 그룹" }).click();
      await expect.poll(() => b.locator(".device-table .table-row:not(.table-head)").count()).toBe(1);
      await b.locator(".device-table").getByText("PC-0", { exact: true }).waitFor();
      await editGroup(b, "공유 시험 그룹").click();
      editor = b.getByRole("dialog", { name: "그룹 편집", exact: true });
      await editor.getByLabel("그룹 이름", { exact: true }).fill("다른 Viewer에서 수정");
      await editor.getByRole("button", { name: "저장", exact: true }).click();
      await editGroup(a, "다른 Viewer에서 수정").waitFor();

      const stores = (page: Page) => page.getByRole("region", { name: "장비 목록", exact: true }).locator(".group-button");
      const initialOrder = await stores(isolated).locator("strong").allTextContents();
      expect(initialOrder).toEqual(["Store A", "Store B"]);
      await stores(a).filter({ hasText: "Store B" }).dragTo(stores(a).filter({ hasText: "Store A" }), { targetPosition: { x: 8, y: 4 } });
      await expect.poll(() => stores(a).locator("strong").allTextContents()).toEqual(["Store B", "Store A"]);
      await expect.poll(() => stores(b).locator("strong").allTextContents()).toEqual(["Store B", "Store A"]);
      expect(await stores(isolated).locator("strong").allTextContents()).toEqual(initialOrder);
      expect(await editGroup(isolated, "공유 시험 그룹").count()).toBe(0);
      expect(await editGroup(isolated, "다른 Viewer에서 수정").count()).toBe(0);
    } finally { await Promise.allSettled(pages.map(page => page.close())); }
  }, 20_000);

  it("account hierarchical groups collapse to main POS, avoid the ungrouped list and never rewrite metadata", async () => {
    const page=await openViewer();
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(()=>{const w=window as any;w.testState.devices[1].storeName='다른 상호';w.testState.devices[1].businessNumber='999-99-99999';w.testState.devices[1].deviceName='메인포스';w.metadataChanges=[];w.testApi.updateFirebaseDeviceMetadata=(...args:any[])=>{w.metadataChanges.push(args);throw Error('unexpected metadata update');};});
      await refresh(page).click();
      await page.getByRole('button',{name:'대그룹 생성',exact:true}).click();
      let dialog=page.getByRole('dialog',{name:'그룹 편집',exact:true});
      await dialog.getByLabel('그룹 이름',{exact:true}).fill('운영 그룹');
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await page.getByRole('button',{name:'운영 그룹 하위 그룹 생성',exact:true}).click();
      dialog=page.getByRole('dialog',{name:'그룹 편집',exact:true});
      await dialog.getByLabel('그룹 이름',{exact:true}).fill('매장 단말');
      await dialog.getByRole('checkbox').filter({hasText:''}).nth(0).check();
      await dialog.getByRole('checkbox').nth(1).check();
      await page.screenshot({path:'../.codex-tmp/viewer-hierarchical-group-editor.png'});
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await page.locator('.custom-group-row .group-button').filter({hasText:'운영 그룹'}).click();
      expect(await page.locator('.device-table .table-row:not(.table-head)').count()).toBe(1);
      expect(await page.locator('.device-table .table-row:not(.table-head)').innerText()).toContain('PC-1');
      expect(await page.getByRole('region',{name:'장비 목록',exact:true}).getByText('다른 상호',{exact:true}).count()).toBe(0);
      await page.locator('.device-inventory-group-toggle').click();
      expect(await page.locator('.device-table .table-row:not(.table-head)').count()).toBe(2);
      expect(await page.getByText('PC-1',{exact:true}).count()).toBe(1);
      expect(await page.evaluate(()=>(window as any).metadataChanges.length)).toBe(0);
      await page.screenshot({path:'../.codex-tmp/viewer-hierarchical-groups.png'});
      await page.evaluate(()=>(window as any).root.unmount());
      await page.addScriptTag({content:bundle});
      await page.locator('.custom-group-row .group-button').filter({hasText:'운영 그룹'}).click();
      await page.locator('.device-inventory-group-toggle').click();
      expect(await page.locator('.device-table .table-row:not(.table-head)').count()).toBe(2);
      await refresh(page).click();
      expect(await page.evaluate(()=>(window as any).testState.refreshTargets.at(-1).sort())).toEqual(['device-0','device-1']);
      await page.evaluate(()=>(window as any).authChanged(true,'viewer-2'));
      await expect.poll(()=>page.getByRole('button',{name:'운영 그룹 그룹 수정',exact:true}).count()).toBe(0);
      expect(await page.evaluate(()=>Array.from((window as any).groupingListeners.keys()))).toEqual(['viewer-2']);
      await page.evaluate(()=>(window as any).authChanged(true,'viewer-1'));
      await page.getByRole('button',{name:'운영 그룹 그룹 수정',exact:true}).waitFor();
      expect(await page.evaluate(()=>Array.from((window as any).groupingListeners.keys()))).toEqual(['viewer-1']);
      const groupingCounts=()=>page.evaluate(()=>{const s=(window as any).testState;return [s.groupingStarts,s.groupingStops];});
      const beforeGrouping=await groupingCounts();
      expect(beforeGrouping[0]-beforeGrouping[1]).toBe(1);
      const before=await counts(page);await page.clock.runFor(86_400_000);expect(await counts(page)).toEqual(before);
      expect(await groupingCounts()).toEqual(beforeGrouping);
      await page.getByRole('button',{name:'운영 그룹 그룹 수정',exact:true}).click();
      dialog=page.getByRole('dialog',{name:'그룹 편집',exact:true});
      const childId=await page.evaluate(()=>(window as any).groupingDocs['viewer-1'].customGroups.find((g:any)=>g.name==='매장 단말').id);
      await dialog.getByLabel('상위 그룹',{exact:true}).selectOption(childId);
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await dialog.getByRole('alert').filter({hasText:'하위 그룹'}).waitFor();
      await page.keyboard.press('Escape');
      expect(await dialog.count()).toBe(0);
      await page.getByRole('button',{name:'매장 단말 그룹 수정',exact:true}).click();
      dialog=page.getByRole('dialog',{name:'그룹 편집',exact:true});
      await dialog.getByLabel('그룹 이름',{exact:true}).fill('단말 묶음');
      await dialog.getByLabel('상위 그룹',{exact:true}).selectOption('');
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await page.getByRole('button',{name:'운영 그룹 그룹 수정',exact:true}).click();
      await page.getByRole('dialog',{name:'그룹 편집',exact:true}).getByRole('button',{name:'그룹 삭제',exact:true}).click();
      await page.locator('.custom-group-row .group-button').filter({hasText:'단말 묶음'}).click();
      await page.locator('.device-inventory-group-toggle').click();
      expect(await page.locator('.device-table .table-row:not(.table-head)').count()).toBe(2);
      await page.setViewportSize({width:390,height:844});
      await page.getByRole('button',{name:'단말 묶음 그룹 수정',exact:true}).click();
      await page.screenshot({path:'../.codex-tmp/viewer-group-editor-narrow.png'});
      expect(await page.getByRole('dialog',{name:'그룹 편집',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})).toBe(true);
      await page.evaluate(id=>{
        const w=window as any;
        const updated=w.groupingDocs['viewer-1'];
        updated.customGroups.find((group:any)=>group.id===id).deviceIds.push('device-2');
        w.groupingListeners.get('viewer-1')(structuredClone(updated));
      },childId);
      await dialog.getByLabel('그룹 이름',{exact:true}).fill('새 이름');
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await page.getByRole('button',{name:'새 이름 그룹 수정',exact:true}).waitFor();
      expect(await page.evaluate(id=>(window as any).groupingDocs['viewer-1'].customGroups.find((g:any)=>g.id===id).deviceIds,childId)).toEqual(['device-0','device-1','device-2']);
      expect(await page.evaluate(()=>(window as any).metadataChanges.length)).toBe(0);
    } finally {await page.close();}
  });
  it("NEW rows always precede online rows after refresh and search", async () => {
    const page=await openViewer();
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.clock.runFor(1_000);
      await page.evaluate(()=>{const w=window as any;w.testState.devices.push({...w.testState.devices[0],id:'new-device',desktopName:'ZZZ-New-PC',status:'offline',firstRegisteredAt:new Date().toISOString()});});
      await refresh(page).click();await page.getByText('NEW',{exact:true}).waitFor();
      expect(await page.locator('.device-table .table-row:not(.table-head)').first().innerText()).toContain('ZZZ-New-PC');
      await page.getByPlaceholder('매장, 장비, 담당자, 연락처, 메모 검색').fill('PC');
      expect(await page.locator('.device-table .table-row:not(.table-head)').first().innerText()).toContain('ZZZ-New-PC');
    } finally {await page.close();}
  });
  it("expires NEW at registration plus24h without network activity, keeps expiry after restart and works on mobile",async()=>{
    for(const mobile of [false,true]){
      const page=await openViewer({mobile});
      try{
        await page.getByText('PC-0',{exact:true}).waitFor();
        await page.clock.pauseAt(new Date(Date.now()+5_000));
        await page.evaluate(()=>{
          const w=window as any;w.testState.devices.push({...w.testState.devices[0],id:'new-expiry',desktopName:'NEW-EXPIRY',firstRegisteredAt:new Date(Date.now()-24*60*60_000+60_000).toISOString()});
          const prefs=JSON.parse(localStorage.getItem('wonremote-viewer-list-v1')!);prefs.baselineAt=new Date(Date.now()-25*60*60_000).toISOString();localStorage.setItem('wonremote-viewer-list-v1',JSON.stringify(prefs));w.root.unmount();
        });
        await page.addScriptTag({content:bundle});await page.getByText('NEW-EXPIRY',{exact:true}).waitFor();
        await page.getByText('NEW',{exact:true}).waitFor();const before=await counts(page);
        await page.clock.runFor(59_999);expect(await page.getByText('NEW',{exact:true}).count()).toBe(1);
        await page.clock.runFor(1);await expect.poll(()=>page.getByText('NEW',{exact:true}).count()).toBe(0);expect(await counts(page)).toEqual(before);
        await page.evaluate(()=>(window as any).root.unmount());await page.addScriptTag({content:bundle});await page.getByText('NEW-EXPIRY',{exact:true}).waitFor();
        expect(await page.getByText('NEW',{exact:true}).count()).toBe(0);
      }finally{await page.close();}
    }
  });
  it("freezes searched refresh targets, retains unrelated statuses, coalesces clicks and restores full refresh after clearing search",async()=>{
    const page=await openViewer();
    try{
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(()=>{
        const w=window as any;w.refreshTargets=[];
        w.testApi.fetchFirebaseDevices=async(_env:any,refresh:boolean,_signal:any,progress:any,known:any[],ids?:string[])=>{
          w.testState.reads++;w.refreshTargets.push(ids??null);
          const selected=w.testState.devices.filter((d:any)=>ids===undefined||ids.includes(d.id));
          progress?.(selected,selected.map((d:any)=>d.id));
          await new Promise(resolve=>w.finishScoped=resolve);
          return selected.map((d:any)=>({...d,status:'online'}));
        };
      });
      const search=page.getByPlaceholder('매장, 장비, 담당자, 연락처, 메모 검색');await search.fill('PC-0');
      await refresh(page).click();await page.waitForFunction(()=>Boolean((window as any).finishScoped));
      await search.fill('PC-1');await refresh(page).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
      expect(await page.evaluate(()=>(window as any).refreshTargets)).toEqual([['device-0']]);
      await page.evaluate(()=>(window as any).finishScoped());await page.clock.runFor(20);
      expect(await page.locator('.table-row').filter({hasText:'PC-1'}).getByText('오프라인',{exact:true}).count()).toBe(1);
      await search.fill('PC-0');expect(await page.locator('.table-row').filter({hasText:'PC-0'}).getByText('온라인',{exact:true}).count()).toBe(1);
      await search.fill('');expect(await page.getByText('PC-9',{exact:true}).count()).toBe(1);
      await refresh(page).click();await page.waitForFunction(()=>(window as any).refreshTargets.length===2);expect(await page.evaluate(()=>(window as any).refreshTargets[1])).toBeNull();
      await page.evaluate(()=>(window as any).finishScoped());
    }finally{await page.close();}
  });
  it("does not mark unseen existing devices NEW and keeps multiple real arrivals together on top across restart", async () => {
    const page=await openViewer();
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.clock.runFor(1_000);
      await page.evaluate(()=>{
        const w=window as any;
        const base=w.testState.devices[0];
        w.testState.devices.push({...base,id:'old-unseen',desktopName:'Old-PC'});
        w.testState.devices.push({...base,id:'new-offline',desktopName:'ZZZ-New-PC',status:'offline',firstRegisteredAt:new Date().toISOString()});
        w.testState.devices.push({...base,id:'new-online',desktopName:'YYY-New-PC',status:'online',firstRegisteredAt:new Date().toISOString()});
      });
      await refresh(page).click();
      await page.getByText('Old-PC',{exact:true}).waitFor();
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(2);
      const rows=page.locator('.device-table .table-row:not(.table-head)');
      for(let i=0;i<2;i++) expect(await rows.nth(i).getByText('NEW',{exact:true}).count()).toBe(1);
      expect(await rows.filter({has:page.getByText('Old-PC',{exact:true})}).getByText('NEW',{exact:true}).count()).toBe(0);
      await page.getByPlaceholder('매장, 장비, 담당자, 연락처, 메모 검색').fill('PC');
      for(let i=0;i<2;i++) expect(await rows.nth(i).getByText('NEW',{exact:true}).count()).toBe(1);
      const before=await counts(page);
      await page.clock.runFor(3_600_000);
      expect(await counts(page)).toEqual(before);
      await page.evaluate(()=>{
        const w=window as any; w.root.unmount();
        w.root=null;
      });
      await page.addScriptTag({content:bundle});
      await page.getByText('Old-PC',{exact:true}).waitFor();
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(2);
      for(let i=0;i<2;i++) expect(await rows.nth(i).getByText('NEW',{exact:true}).count()).toBe(1);
      await page.screenshot({path:'../.codex-tmp/viewer-new-first.png'});
      await rows.first().getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'등록 장비 수정',exact:true});
      await dialog.getByRole('button',{name:'취소',exact:true}).click();
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(2);
      await page.evaluate(()=>{
        const w=window as any;
        w.testApi.updateFirebaseDeviceMetadata=async(id:string,input:any)=>{
          if(w.failMetadata) throw Error('Save failed');
          const index=w.testState.devices.findIndex((d:any)=>d.id===id);
          return w.testState.devices[index]={...w.testState.devices[index],...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined))};
        };
        w.failMetadata=true;
      });
      await rows.first().getByRole('button',{name:'장비 정보 수정',exact:true}).click();
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await dialog.getByText('Save failed',{exact:false}).waitFor();
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(2);
      await page.evaluate(()=>(window as any).failMetadata=false);
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(1);
      expect(await rows.first().getByText('NEW',{exact:true}).count()).toBe(1);
    } finally {await page.close();}
  });
  it("repairs legacy badges once in the actual Viewer while preserving group and favorite preferences", async () => {
    const page=await openViewer();
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(()=>{
        const w=window as any; w.root.unmount();
        localStorage.setItem('wonremote-viewer-list-v1',JSON.stringify({groupOrder:['Store'],knownDeviceIds:['device-0'],newDeviceIds:['device-0','device-9'],customGroups:[{id:'saved',name:'Saved group',parentId:null,deviceIds:['device-0']}]}));
        localStorage.setItem('wonremote-favorite-devices',JSON.stringify(['device-0']));
      });
      await page.addScriptTag({content:bundle});
      await page.getByText('PC-0',{exact:true}).waitFor();
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(0);
      expect(await page.getByRole('button',{name:'PC-0 즐겨찾기',exact:true}).getAttribute('aria-pressed')).toBe('true');
      const prefs=await page.evaluate(()=>JSON.parse(localStorage.getItem('wonremote-viewer-list-v1')!));
      expect(prefs.groupOrder).toEqual(['Store']);
      expect(prefs.customGroups[0].deviceIds).toEqual(['device-0']);
      expect(prefs.knownDeviceIds).toHaveLength(10);
      expect(prefs.baselineAt).toBeTruthy();
      await refresh(page).click();
      expect(await page.getByText('NEW',{exact:true}).count()).toBe(0);
    } finally {await page.close();}
  });
  it.each(["text", "image"])("clipboard success notification is nonblocking for one second: %s", async (kind) => {
    const page = await openViewer({connected:true});
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const send = page.getByRole('button',{name:'클립보드 동기화: 내 PC → 원격 PC',exact:true});
      await send.waitFor();
      await page.evaluate((kind) => {
        const w = window as any; w.clipboardSends = 0;
        Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
          read: async () => kind === 'image' ? [{types:['image/png'],getType:async () => new Blob(['fixture'],{type:'image/png'})}] : [],
          readText: async () => 'clipboard fixture',
        }});
        w.testApi.sendFirebaseClipboardText = async () => { w.clipboardSends++; if (w.clipboardFail) throw Error('Clipboard rejected'); if (w.clipboardSlow) await new Promise(resolve => {w.finishClipboard = resolve;}); };
        w.testSendFile = async () => {w.clipboardSends++; return true;};
      }, kind);
      // Mocked API counters; rendering, timing and toolbar behavior are the real App.
      const before = await counts(page);
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await send.click();
      const notice = page.locator('.session-clipboard-notice');
      await notice.waitFor();
      expect(await notice.getAttribute('role')).toBe('status');
      expect(await notice.innerText()).toBe(`클립보드 ${kind === 'text' ? '텍스트' : '이미지'} 전송 완료`);
      expect(dialogs).toEqual([]);
      await page.clock.runFor(999);
      expect(await notice.count()).toBe(1);
      await send.click();
      await expect.poll(() => page.evaluate(() => (window as any).clipboardSends)).toBe(2);
      await page.clock.runFor(1);
      expect(await notice.count()).toBe(1);
      await page.clock.runFor(999);
      expect(await notice.count()).toBe(0);
      await page.clock.runFor(86_400_000);
      expect(await counts(page)).toEqual(before);
      expect(await page.evaluate(() => (window as any).clipboardSends)).toBe(2);
    } finally { await page.close(); }
  });

  it("clipboard success notification rejects failure, duplicate and late unmounted completion", async () => {
    const page = await openViewer({connected:true});
    const dialogs: string[] = [];
    page.on('dialog', dialog => {dialogs.push(dialog.message()); void dialog.dismiss();});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const send = page.getByRole('button',{name:'클립보드 동기화: 내 PC → 원격 PC',exact:true});
      await send.waitFor();
      await page.evaluate(() => {
        const w = window as any; w.clipboardSends=0; w.clipboardFail=true;
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[],readText:async()=> 'fixture'}});
        w.testApi.sendFirebaseClipboardText = async () => {w.clipboardSends++; if(w.clipboardFail) throw Error('Clipboard rejected'); await new Promise(resolve=>{w.finishClipboard=resolve;});};
      });
      await send.click();
      await expect.poll(()=>dialogs.length).toBe(1);
      expect(dialogs[0]).toBe('Clipboard rejected');
      expect(await page.locator('.session-clipboard-notice').count()).toBe(0);
      await page.evaluate(()=>{(window as any).clipboardFail=false;});
      await send.evaluate((element:HTMLButtonElement)=>{element.click();element.click();});
      await expect.poll(()=>page.evaluate(()=>(window as any).clipboardSends)).toBe(2);
      await page.evaluate(()=>{const w=window as any; w.root.unmount(); w.noticeTimers=0; const timer=window.setTimeout; window.setTimeout=((callback:any,delay:number,...args:any[])=>{if(delay===1000)w.noticeTimers++;return timer(callback,delay,...args);}) as any; w.finishClipboard();});
      await page.clock.runFor(1001);
      expect(await page.evaluate(()=>(window as any).noticeTimers)).toBe(0);
      expect(dialogs).toHaveLength(1);
    } finally { await page.close(); }
  });

  it.each(["denied", "awaiting server"])("shows unavailable account group access and requires an explicit retry: %s", async state => {
    const page = await openViewer({}, undefined, p => p.evaluate(state => {
      (window as any).rejectGrouping = state === "denied";
      (window as any).holdGrouping = state === "awaiting server";
    }, state));
    try {
      const groups = page.getByRole("region", {name:"사용자 그룹"});
      const add = groups.getByRole("button", {name:"대그룹 생성"});
      const retry = groups.getByRole("button", {name:"그룹 다시 불러오기"});
      const status = groups.getByRole(state === "denied" ? "alert" : "status");
      await status.waitFor();
      expect(await add.isDisabled()).toBe(true);
      expect(await status.innerText()).toContain(state === "denied" ? "권한" : "확인 중");
      const starts = await page.evaluate(() => (window as any).testState.groupingStarts);
      await page.evaluate(() => {
        const w = window as any;
        w.rejectGrouping = false;
        w.holdGrouping = false;
        w.groupingDocs["viewer-1"] = {customGroups:[{id:"a",name:"복구된 그룹",parentId:null,deviceIds:[]}],groupOrder:[]};
      });
      expect(await add.isDisabled()).toBe(true);
      await retry.click();
      await groups.getByRole("button", {name:/복구된 그룹 0/}).waitFor();
      expect(await add.isEnabled()).toBe(true);
      expect(await groups.getByRole("alert").count()).toBe(0);
      expect(await page.evaluate(() => {
        const w = window as any;
        return [w.testState.groupingStarts, w.groupingListeners.size];
      })).toEqual([starts + 1, 1]);
    } finally { await page.close(); }
  });

  it("sends remote Win+D from the button immediately after monitor selection", async () => {
    const page = await openViewer({desktop:true,connected:true}, undefined, p => p.evaluate(() => {
      (window as any).testState.devices[0].displays = [
        {index:0, name:"DISPLAY1", width:1920, height:1080, primary:true},
        {index:1, name:"DISPLAY2 WITH A LONG MONITOR NAME", width:2560, height:1440, primary:false},
      ];
    }));
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const desktop = page.getByRole("button", {name:"원격 바탕화면 (Win+D)",exact:true});
      await desktop.waitFor();
      expect(await desktop.evaluate(e => e.previousElementSibling?.getAttribute("aria-label"))).toBe("모니터 선택");
      const control = page.getByRole("button", {name:"제어모드",exact:true});
      for (const width of [1920,1501,1440,1024]) {
        await page.setViewportSize({width,height:768});
        for (const button of [desktop, control]) await expect.poll(() => button.evaluate(e => {
          const r = e.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          if (r.left >= 0 && r.right <= innerWidth && e.contains(hit)) return true;
          return {left:r.left,right:r.right,top:r.top,hit:hit?.outerHTML.slice(0,170)};
        }), {message:`Toolbar buttons must be reachable at ${width}px`}).toBe(true);
      }
      await page.evaluate(() => { (window as any).testState.controls = []; });
      await desktop.click();
      expect(await page.evaluate(() => (window as any).testState.controls)).toEqual(["key-down Win","keypress D","key-up Win"]);
    } finally { await page.close(); }
  });

  it("pauses remote control without losing transport or sticking held keys and buttons", async () => {
    const page = await openViewer({desktop:true,connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const toggle = page.getByRole("button", {name:"제어모드", exact:true});
      const desktop = page.getByRole("button", {name:"원격 바탕화면 (Win+D)"});
      const ime = page.locator('[data-remote-ime-input="true"]');
      const canvas = page.locator("canvas.remote-canvas");
      const inputs = () => page.evaluate(() => (window as any).testState.controls as string[]);
      await toggle.waitFor();
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      expect(await toggle.evaluate(e => getComputedStyle(e).backgroundColor)).toBe("rgb(155, 44, 55)");
      expect(await toggle.evaluate(e => e.previousElementSibling?.getAttribute("aria-label"))).toBe("원격 바탕화면 (Win+D)");
      await expect.poll(() => desktop.isEnabled()).toBe(true);
      const rect = (await canvas.boundingBox())!;
      await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
      await page.mouse.down();
      await page.keyboard.down("Control");
      await expect.poll(async () => (await inputs()).some(action=>action.startsWith("mouse-down "))).toBe(true);
      expect(await inputs()).toContain("key-down Ctrl");
      await toggle.evaluate(element => (element as HTMLButtonElement).click());
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      expect(await inputs()).toContain("key-release-all");
      expect((await inputs()).some(action=>action.startsWith("mouse-up "))).toBe(true);
      expect(await desktop.isDisabled()).toBe(true);
      await page.evaluate(()=>(window as any).testState.controls=[]);
      await page.keyboard.up("Control");
      await page.mouse.up();
      await page.keyboard.press("ArrowRight");
      await page.mouse.move(rect.x+rect.width/2+5,rect.y+rect.height/2);
      await page.mouse.wheel(0,120);
      await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
      await ime.evaluate(e => { (e as HTMLTextAreaElement).value="blocked"; e.dispatchEvent(new InputEvent("input",{bubbles:true})); });
      await page.evaluate(() => {
        const picture = document.createElement("canvas");
        picture.width = picture.height = 32;
        const ctx = picture.getContext("2d")!;
        ctx.fillStyle = "#00e600";
        ctx.fillRect(0,0,32,32);
        (window as any).rtcCallbacks.onFrame({ sequence:1,keyframe:true,width:32,height:32,
          tiles:[{x:0,y:0,w:32,h:32,data:picture.toDataURL("image/jpeg").split(",")[1]}] });
      });
      await expect.poll(() => canvas.evaluate(e => (e as HTMLCanvasElement).getContext("2d")!.getImageData(12,12,1,1).data[1])).toBeGreaterThan(210);
      expect(await inputs()).toEqual([]);
      expect(await page.evaluate(() => (window as any).testState.rtcStarts)).toBe(1);
      await toggle.click();
      await desktop.click();
      expect(await inputs()).toEqual(["key-down Win","keypress D","key-up Win"]);
    } finally { await page.close(); }
  });

  it("pauses mobile mouse and keyboard input while keeping local zoom and tools", async () => {
    const page = await openViewer({mobile:true,connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})}).getByRole("button",{name:"접속",exact:true}).click();
      const settings = page.getByRole("button",{name:"화면 및 세션 설정",exact:true});
      const toggle = page.getByRole("button",{name:"제어모드",exact:true});
      const click = page.getByRole("button",{name:"좌클릭",exact:true});
      const keyboard = page.getByRole("button",{name:"키보드",exact:true});
      const touchpad = page.getByLabel("원격 터치패드",{exact:true});
      await page.getByRole("button",{name:"터치패드 모드",exact:true}).click();
      await touchpad.waitFor();
      await settings.click();
      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      const tools = page.getByTestId("secondary-tools");
      await tools.getByRole("button",{name:"채팅",exact:true}).click();
      expect(await settings.getAttribute("aria-expanded")).toBe("false");
      expect(await click.isDisabled()).toBe(true);
      expect(await keyboard.isDisabled()).toBe(true);
      await touchpad.waitFor({state:"detached"});
      const canvas = page.locator("canvas.remote-canvas");
      const before = await canvas.evaluate(e => e.style.transform);
      await page.getByRole("button",{name:"확대",exact:true}).click();
      await expect.poll(() => canvas.evaluate(e => e.style.transform)).not.toBe(before);
      await settings.click();
      await toggle.click();
      await page.getByRole("button",{name:"도구 닫기",exact:true}).click();
      await touchpad.waitFor();
      expect(await click.isEnabled()).toBe(true);
      expect(await keyboard.isEnabled()).toBe(true);
    } finally { await page.close(); }
  });

  it("closes Viewer tools after a command but not its first safety confirmation", async () => {
    const page = await openViewer({desktop:true,connected:true});
    page.on("dialog", dialog => void dialog.accept());
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const tools = page.getByTestId("secondary-tools");
      const open = () => tools.evaluate(e => (e as HTMLDetailsElement).open);
      await tools.locator("summary").click();
      await tools.getByRole("button", {name:"채팅", exact:true}).click();
      expect(await open()).toBe(false);
      await tools.locator("summary").click();
      const chooser = page.waitForEvent("filechooser");
      await tools.getByRole("button", {name:/^파일 전송/}).click();
      await chooser;
      expect(await open()).toBe(false);
      await tools.locator("summary").click();
      const restart = tools.getByRole("button", {name:"재시작",exact:true});
      const restarts = () => page.evaluate(() => (window as any).testState.controls.filter((action:string) => action === "system restart"));
      await restart.click();
      expect(await open()).toBe(true);
      expect(await restarts()).toEqual([]);
      await restart.click();
      expect(await open()).toBe(false);
      expect(await restarts()).toEqual(["system restart"]);
    } finally { await page.close(); }
  });

  it("clipboard history sends remote Win+V to the right of transfer without copying clipboard data", async () => {
    const page=await openViewer({connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.locator('[data-remote-ime-input="true"]').waitFor({state:'attached'});
      await page.evaluate(()=>(window as any).testState.controls=[]);
      const history=page.getByRole('button',{name:'원격 클립보드 열기 (Win+V)',exact:true});
      await history.click();
      expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual(['key-down Win','keypress V','key-up Win']);
      expect(await history.evaluate(element=>element.previousElementSibling?.getAttribute('aria-label'))).toBe('클립보드 동기화: 내 PC → 원격 PC');
      expect(await page.evaluate(()=>(window as any).testState.auxiliaryReads)).toBe(0);
    } finally {await page.close();}
  });
  it("toolbar shortcuts keep logos and labels and send fixed remote browser commands without local launch", async () => {
    const page=await openViewer({desktop:true,connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const edge=page.getByRole('button',{name:'Microsoft Edge 다운로드',exact:true});
      const asp=page.getByRole('button',{name:'FirstPOS ASP 열기',exact:true});
      const toss=page.getByRole('button',{name:'TossEmergencyOrders 다운로드',exact:true});
      await edge.waitFor();
      expect(await edge.innerText()).toBe('Download'); expect(await asp.innerText()).toBe('ASP');
      expect(await toss.innerText()).toBe('TossEmergencyOrders');
      expect(await toss.evaluate(e=>e.nextElementSibling?.getAttribute('aria-label'))).toBe('Microsoft Edge 다운로드');
      expect(await toss.getAttribute('href')).toBe(null);
      expect(await edge.getAttribute('href')).toBe(null);
      expect(await asp.getAttribute('href')).toBe(null);
      expect(await edge.evaluate(e=>e.nextElementSibling?.getAttribute('aria-label'))).toBe('FirstPOS ASP 열기');
      expect(await asp.evaluate(e=>e.nextElementSibling?.getAttribute('aria-label'))).toBe('클립보드 동기화: 내 PC → 원격 PC');
      await toss.click();
      for(const link of [edge,asp]) {
        expect(await link.locator('img').evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
        await link.click();
      }
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='open_viewer_shortcut'))).toEqual([]);
      await expect.poll(()=>page.evaluate(()=>(window as any).testState.controls.filter((action:string)=>action.startsWith('system ')))).toEqual(['system toss-emergency-download','system edge-download','system asp-login']);
      await page.setViewportSize({width:1024,height:768});
      for(const link of [toss,edge,asp]) expect(await link.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth;})).toBe(true);
      await page.screenshot({path:'../.codex-tmp/viewer-browser-shortcuts.png'});
      expect(await page.context().pages()).toHaveLength(1);
    } finally {await page.close();}
  });
  it("browser edition shortcuts also send remote commands and never open a local tab", async () => {
    const page=await openViewer({connected:true});
    try {
      await page.context().route(/https:\/\/(asp\.firstpos\.co\.kr|c2rsetup\.officeapps\.live\.com)\//,route=>route.fulfill({contentType:'text/html',body:'<title>Shortcut target</title>'}));
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      for(const name of ['TossEmergencyOrders 다운로드','Microsoft Edge 다운로드','FirstPOS ASP 열기']) {
        await page.getByRole('button',{name,exact:true}).click();
      }
      await expect.poll(()=>page.evaluate(()=>(window as any).testState.controls.filter((action:string)=>action.startsWith('system ')))).toEqual(['system toss-emergency-download','system edge-download','system asp-login']);
      expect(page.context().pages()).toHaveLength(1);
    } finally {await page.close();}
  });

  it("toolbar shortcuts keep old Agents from receiving unsupported Toss download commands", async () => {
    const page=await openViewer({connected:true});
    try {
      await page.getByText('PC-0',{exact:true}).waitFor();
      await page.evaluate(()=>{(window as any).testState.devices[0].version='0.1.111';});
      await refresh(page).click();
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      const toss=page.getByRole('button',{name:'TossEmergencyOrders 다운로드',exact:true});
      expect(await toss.isDisabled()).toBe(true);
      expect(await toss.getAttribute('title')).toContain('0.1.112');
      expect(await page.getByRole('button',{name:'Microsoft Edge 다운로드',exact:true}).isEnabled()).toBe(true);
      expect(await page.evaluate(()=>(window as any).testState.controls.filter((action:string)=>action.startsWith('system ')))).toEqual([]);
    } finally {await page.close();}
  });

  it.each([{width:320,height:568},{width:390,height:844},{width:844,height:390}])("mobile Toss shortcut stays readable and downloads only on the remote PC at $width x $height", async viewport => {
    const page=await openViewer({connected:true,mobile:true,emulateMobile:true,nativeAndroid:true,viewport});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).tap();
      await page.getByRole('button',{name:'화면 및 세션 설정',exact:true}).tap();
      const toss=page.getByRole('button',{name:'TossEmergencyOrders 다운로드',exact:true});
      expect(await toss.innerText()).toBe('TossEmergencyOrders');
      expect(await toss.evaluate(e=>e.nextElementSibling?.getAttribute('aria-label'))).toBe('Microsoft Edge 다운로드');
      expect(await toss.getAttribute('href')).toBe(null);
      await toss.tap();
      expect(await toss.evaluate(e=>{const r=e.getBoundingClientRect();const label=e.querySelector('span')!.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth&&label.left>=r.left&&label.right<=r.right;})).toBe(true);
      await expect.poll(()=>page.evaluate(()=>(window as any).testState.controls.filter((action:string)=>action.startsWith('system ')))).toEqual(['system toss-emergency-download']);
      expect(page.context().pages()).toHaveLength(1);
      expect(await page.evaluate(()=>document.activeElement?.getAttribute('data-remote-ime-input'))).not.toBe('true');
      await page.screenshot({path:`../.codex-tmp/mobile-toss-${viewport.width}.png`});
    } finally {await page.close();}
  });
  it.each([true, false])("Agent standby footer stays clickable without scrolling (firstRun=%s)", async firstRun => {
    const page = await openViewer({desktop:true,agent:true,firstRun,viewport:{width:360,height:420}});
    try {
      await page.getByRole('heading',{name:firstRun?'Agent 최초 실행':'Agent 가동 중',exact:true}).waitFor();
      const standby = page.getByRole('button',{name:'ZOOK 대기',exact:true});
      await page.getByLabel('ZOOK 고유번호 (선택)',{exact:true}).fill('00123456');
      const visibleHitTarget = async () => standby.evaluate(button => {
        const r=button.getBoundingClientRect();
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&Boolean(hit&&button.contains(hit));
      });
      for (const viewport of [{width:320,height:340},{width:360,height:340},{width:360,height:420},{width:480,height:560}]) {
        await page.setViewportSize(viewport);
        expect(await visibleHitTarget()).toBe(true);
        const initial = await standby.boundingBox();
        expect(await page.locator('.agent-panel-scroll').count()).toBe(1);
        await page.locator('.agent-panel-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight;});
        if (viewport.height===340) {
          expect(await page.locator('.agent-panel-scroll').evaluate(e=>getComputedStyle(e).overflowY==='auto'&&e.scrollTop>0)).toBe(true);
        }
        expect(await visibleHitTarget()).toBe(true);
        expect((await standby.boundingBox())!.y).toBeCloseTo(initial!.y,1);
        if (firstRun) {
          expect(await page.getByRole('button',{name:'등록',exact:true}).evaluate(button=>{
            const r=button.getBoundingClientRect();return r.bottom<=innerHeight&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
          })).toBe(true);
        }
        if (viewport.width===360&&viewport.height===420) {
          await page.locator('.agent-panel-scroll').evaluate(e=>{e.scrollTop=0;});
          await page.screenshot({path:`../.codex-tmp/agent-footer-${firstRun?'first-run':'active'}-420.png`});
        }
      }
      await page.setViewportSize({width:360,height:340});
      await page.evaluate(()=>{(window as any).zookFailure='설치 상태를 확인할 수 없습니다. '.repeat(20);});
      await standby.click();
      await page.evaluate(()=>(window as any).finishZook());
      await page.getByRole('alert').filter({hasText:'설치 상태를 확인할 수 없습니다.'}).waitFor();
      expect(await visibleHitTarget()).toBe(true);
      expect(await page.evaluate(()=>({pageScroll:document.documentElement.scrollHeight>innerHeight,
        calls:(window as any).nativeCalls.filter((c:any)=>c.command==='configure_zook_agent').length}))).toEqual({pageScroll:false,calls:1});
      await page.screenshot({path:`../.codex-tmp/agent-footer-${firstRun?'first-run':'active'}-340.png`});
    } finally {await page.close();}
  });

  it("ZOOK setup preserves leading zeroes and Agent registration, deduplicates clicks and stays idle", async () => {
    const page = await openViewer({desktop:true,agent:true,viewport:{width:360,height:420}});
    try {
      const input = page.getByLabel('ZOOK 고유번호 (선택)',{exact:true});
      const button = page.getByRole('button',{name:'ZOOK 대기',exact:true});
      await input.waitFor();
      await page.getByText('123-45-67890',{exact:true}).waitFor();
      await expect.poll(()=>input.inputValue()).toBe('00123456');
      await input.fill('');
      expect(await button.isDisabled()).toBe(true);
      await input.fill('1234abcd');
      expect(await button.isDisabled()).toBe(true);
      await input.fill('00123456');
      await button.click();
      const pending = page.getByRole('button',{name:'설정 중',exact:true});
      await expect.poll(()=>pending.isDisabled()).toBe(true);
      for (let i=0;i<3;i++) await pending.dispatchEvent('click');
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='configure_zook_agent').length)).toBe(1);
      await page.evaluate(()=>(window as any).finishZook());
      await page.getByRole('status').filter({hasText:'014-0012-3456'}).waitFor();
      expect(await input.inputValue()).toBe('00123456');
      await page.clock.runFor(86_400_000);
      const calls = await page.evaluate(()=>(window as any).nativeCalls.map((c:any)=>c.command));
      expect(calls.filter((c:string)=>c==='configure_zook_agent').length).toBe(1);
      expect(calls.filter((c:string)=>c==='load_zook_number').length).toBeLessThanOrEqual(2);
      expect(calls.includes('save_agent_config')).toBe(false);
      expect(await counts(page)).toEqual({reads:0,subscriptions:0});
      expect(await page.getByText('123-45-67890:AGENT-0',{exact:true}).count()).toBe(1);
      const bounds = await page.locator('.agent-zook-row').boundingBox();
      const buttonBounds = await button.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(360);
      const updateBounds = await page.getByRole('button',{name:'업데이트 확인',exact:true}).boundingBox();
      expect(updateBounds!.y + updateBounds!.height).toBeLessThanOrEqual(420);
      await page.screenshot({path:'../.codex-tmp/agent-zook-360.png'});
    } finally { await page.close(); }
  });

  it("ZOOK failure is separate from first-run registration and ignores late completion after unmount", async () => {
    const page = await openViewer({desktop:true,agent:true,firstRun:true});
    try {
      await page.getByRole('heading',{name:'Agent 최초 실행',exact:true}).waitFor();
      const input = page.getByLabel('ZOOK 고유번호 (선택)',{exact:true});
      await input.fill('34778178');
      await page.getByRole('button',{name:'ZOOK 대기',exact:true}).click();
      await page.evaluate(()=>{const w=window as any;w.zookFailure='ZOOK 대기가 취소되지 않았습니다. 입력값은 변경하지 않았습니다.';w.finishZook();});
      await page.getByRole('alert').filter({hasText:'대기가 취소되지'}).waitFor();
      expect(await page.getByRole('button',{name:'등록',exact:true}).isEnabled()).toBe(true);
      expect(await input.inputValue()).toBe('34778178');
      await page.getByRole('button',{name:'ZOOK 대기',exact:true}).click();
      await page.evaluate(()=>{const w=window as any;w.root.unmount();w.zookFailure=null;w.finishZook();});
      await page.clock.runFor(86_400_000);
      expect(await page.locator('#root').innerText()).toBe('');
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='configure_zook_agent').length)).toBe(2);
      expect(await counts(page)).toEqual({reads:0,subscriptions:0});
    } finally { await page.close(); }
  });

  it("saves a business-number edit through the right-click editor without changing device ID", async () => {
    const page = await openViewer({desktop:true});
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.businessEdits = [];
        w.testApi.updateFirebaseDeviceMetadata = async (id:string,input:any) => {
          w.businessEdits.push({id,input});
          const device = w.testState.devices.find((d:any)=>d.id===id);
          Object.assign(device,Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined))); return structuredClone(device);
        };
      });
      await page.locator('.table-row').filter({hasText:'PC-0'}).click({button:'right'});
      const dialog = page.getByRole('dialog',{name:'등록 장비 수정',exact:true});
      await dialog.getByLabel('사업자번호',{exact:true}).fill('987-65-43210');
      await dialog.getByLabel('ZOOK 고유번호',{exact:true}).fill('00123456');
      await dialog.getByRole('button',{name:'저장',exact:true}).click();
      await expect.poll(()=>dialog.count()).toBe(0);
      const row = page.locator('.table-row').filter({hasText:'PC-0'});
      expect(await row.innerText()).toContain('987-65-43210');
      expect(await page.evaluate(()=>(window as any).businessEdits[0])).toMatchObject({id:'device-0',input:{businessNumber:'987-65-43210',zookNumber:'00123456'}});
      await row.click({button:'right'});
      expect(await dialog.getByLabel('ZOOK 고유번호',{exact:true}).inputValue()).toBe('00123456');
      await page.screenshot({path:'../.codex-tmp/viewer-zook-number-edit.png'});
      await dialog.getByRole('button',{name:'취소',exact:true}).click();
      await page.screenshot({path:'../.codex-tmp/viewer-business-number-edit.png'});
      await page.locator('.group-list .group-button').filter({hasText:'Store'}).click({button:'right'});
      const groupDialog = page.getByRole('dialog');
      expect(await groupDialog.getByLabel('사업자번호',{exact:true}).evaluate((input:HTMLInputElement)=>input.readOnly)).toBe(true);
      await groupDialog.getByRole('button',{name:'저장',exact:true}).click();
      await expect.poll(()=>groupDialog.count()).toBe(0);
      expect(await page.evaluate(()=>(window as any).businessEdits.slice(1).every((edit:any)=>!Object.prototype.hasOwnProperty.call(edit.input,'businessNumber')))).toBe(true);
      expect(await page.evaluate(()=>(window as any).businessEdits.slice(1).every((edit:any)=>!Object.prototype.hasOwnProperty.call(edit.input,'zookNumber')))).toBe(true);
      expect(await row.innerText()).toContain('987-65-43210');
    } finally { await page.close(); }
  });

  it("refreshes the open Agent business number on the native config-change event without cloud polling", async () => {
    const page = await openViewer({desktop:true,agent:true});
    try {
      await page.getByText('123-45-67890',{exact:true}).waitFor();
      await page.evaluate(()=>{
        const w = window as any;
        w.agentConfig = {businessNumber:'987-65-43210',registeredDeviceId:'123-45-67890:AGENT-0',installId:'test-agent'};
        w.nativeEvents['agent-config-changed']({payload:null});
      });
      await page.getByText('987-65-43210',{exact:true}).waitFor();
      expect(await page.getByText('123-45-67890:AGENT-0',{exact:true}).count()).toBe(1);
      await page.clock.runFor(86_400_000);
      expect(await counts(page)).toEqual({reads:0,subscriptions:0});
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((call:any)=>call.command==='get_agent_config').length)).toBe(2);
      await page.screenshot({path:'../.codex-tmp/agent-business-number-sync.png'});
    } finally { await page.close(); }
  });
  it("opens notification settings without applying ZOOK and refreshes a remote number without idle polling", async () => {
    const page = await openViewer({desktop:true,agent:true,viewport:{width:360,height:420}});
    try {
      await page.getByLabel('ZOOK Windows 알림 설정',{exact:true}).click();
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='open_zook_notification_settings').length)).toBe(1);
      expect(await page.evaluate(()=>(window as any).nativeCalls.filter((c:any)=>c.command==='configure_zook_agent').length)).toBe(0);
      await page.evaluate(()=>{
        const w=window as any;
        w.zookNumber='00876543';
        w.nativeEvents['agent-config-changed']({payload:null});
      });
      await expect.poll(()=>page.getByLabel('ZOOK 고유번호 (선택)',{exact:true}).inputValue()).toBe('00876543');
      const box=await page.getByLabel('ZOOK Windows 알림 설정',{exact:true}).boundingBox();
      expect(box!.x+box!.width).toBeLessThanOrEqual(360);
      expect(box!.y+box!.height).toBeLessThanOrEqual(420);
      await page.screenshot({path:'../.codex-tmp/agent-zook-notification-settings.png'});
    } finally {await page.close();}
  });

  it("checks the existing list during a slow read without false online or duplicate commands", async () => {
    const page = await openViewer({ manual: true });
    try {
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      await page.evaluate(() => { (window as any).parallelRefresh = true; });
      await refresh(page).click();
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(10);
      expect(await page.getByText("PC-0", { exact: true }).count()).toBe(1);
      expect(await page.locator(".status-pill.online").count()).toBe(0);
      await page.evaluate(() => (window as any).replyParallel("device-0"));
      await expect.poll(() => page.locator(".status-pill.online").count()).toBe(1);
      for (let i = 0; i < 3; i++) await refresh(page).dispatchEvent("click");
      await page.getByPlaceholder("매장, 장비, 담당자, 연락처, 메모 검색").fill("PC");
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
      expect(await page.evaluate(() => (window as any).testState.presenceCommands.length)).toBe(10);
      await page.clock.runFor(2_000);
      await page.evaluate(() => {
        const w = window as any;
        w.testState.devices = w.testState.devices.slice(0, 9).map((d: any) => ({ ...d, desktopName: `Fresh-${d.desktopName}` }));
        w.testState.devices[8].presenceMode = undefined;
        w.testState.devices.push({ ...w.testState.devices[0], id: "new", desktopName: "New-PC", firstRegisteredAt: new Date().toISOString() });
        w.finishParallelRead();
      });
      await page.getByText("Fresh-PC-0", { exact: true }).waitFor();
      expect(await page.getByText("PC-9", { exact: true }).count()).toBe(0);
      expect(await page.getByText("New-PC", { exact: true }).count()).toBe(1);
      expect(await page.getByText("NEW", { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => (window as any).testState.presenceCommands.length)).toBe(11);
      expect(await page.evaluate(() => (window as any).testState.presenceStarts)).toBe(1);
      await page.screenshot({ path: "../.codex-tmp/viewer-parallel-refresh.png" });
      await page.clock.runFor(3_000);
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(1);
      expect(await page.getByText("응답 없음", { exact: true }).count()).toBe(7);
      await page.locator(".table-row").filter({ hasText: "New-PC" }).getByText("확인 중", { exact: true }).waitFor();
      await page.clock.runFor(2_000);
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      expect(await page.locator(".status-pill.online").count()).toBe(1);
      expect(await page.getByText("응답 없음", { exact: true }).count()).toBe(8);
      expect(await page.locator(".table-row .status-pill.offline").count()).toBe(1);
      expect(await page.locator(".summary-item.offline strong").textContent()).toBe("1");
      const unansweredRow = page.locator(".table-row").filter({ hasText: "Fresh-PC-1" });
      await unansweredRow.getByRole("button", { name: "장비 진단", exact: true }).click();
      const diagnostic = page.getByRole("dialog");
      await diagnostic.getByText("응답 없음", { exact: true }).waitFor();
      await diagnostic.getByRole("button", { name: "닫기", exact: true }).click();
      await page.screenshot({ path: "../.codex-tmp/viewer-presence-timeout.png" });
      await page.getByRole("group", { name: "장비 상태 필터" }).getByRole("button", { name: "오프라인", exact: true }).click();
      await expect.poll(() => page.getByText("Fresh-PC-1", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Fresh-PC-8", { exact: true }).count()).toBe(1);
      await page.clock.runFor(86_400_000);
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
      expect(await page.evaluate(() => (window as any).testState.presenceCommands.length)).toBe(11);
      expect(await page.evaluate(() => (window as any).testState.presenceStops)).toBe(1);
    } finally { await page.close(); }
  });

  it("aborts the parallel owner on logout and ignores its late list and replies", async () => {
    const page = await openViewer({ manual: true });
    try {
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      await page.evaluate(() => { (window as any).parallelRefresh = true; });
      await refresh(page).click();
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(10);
      await page.evaluate(() => (window as any).authChanged(false));
      await page.locator('input[name="username"]').waitFor();
      await page.evaluate(() => {
        const w = window as any;
        w.testState.devices.push({ ...w.testState.devices[0], id: "late", desktopName: "Late-PC" });
        w.finishParallelRead(); w.replyParallel("device-0");
      });
      await page.clock.runFor(86_400_000);
      expect(await page.getByText("Late-PC", { exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => (window as any).testState.presenceCommands.length)).toBe(10);
      expect(await page.evaluate(() => (window as any).testState.presenceStops)).toBe(1);
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("edits device fields and opens device type with an ordinary left pointer", async () => {
    const page = await openViewer({ desktop: true });
    try {
      await page.evaluate(() => {
        const w = window as any;
        w.deviceTypePickerCalls = 0;
        Object.defineProperty(HTMLSelectElement.prototype, "showPicker", {
          configurable: true,
          value() { w.deviceTypePickerCalls += 1; },
        });
      });
      await page.locator('.table-row').filter({ hasText: 'PC-0' }).getByRole('button', { name: '장비 정보 수정', exact: true }).click();

      const dialog = page.getByRole('dialog', { name: '등록 장비 수정', exact: true });
      const contact = dialog.getByLabel('담당자', { exact: true });
      const contactBox = await contact.boundingBox();
      expect(contactBox).not.toBeNull();
      await page.mouse.click(contactBox!.x + contactBox!.width / 2, contactBox!.y + contactBox!.height / 2);
      await page.keyboard.type('좌클릭 입력');
      expect(await contact.inputValue()).toBe('좌클릭 입력');
      expect(await contact.evaluate((element) => document.activeElement === element)).toBe(true);

      const deviceType = dialog.locator('select').first();
      const deviceTypeBox = await deviceType.boundingBox();
      expect(deviceTypeBox).not.toBeNull();
      await page.mouse.click(deviceTypeBox!.x + deviceTypeBox!.width / 2, deviceTypeBox!.y + deviceTypeBox!.height / 2);
      expect(await page.evaluate(() => (window as any).deviceTypePickerCalls)).toBe(1);
      expect(await deviceType.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await page.locator('aside.sidebar').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
      expect(await page.locator('main.workspace').evaluate((element) => (element as HTMLElement).inert)).toBe(true);
      expect(await dialog.locator('..').evaluate((element) => Number(getComputedStyle(element).zIndex))).toBeGreaterThan(104);

      await dialog.getByRole('button', { name: '취소', exact: true }).click();
      expect(await page.locator('aside.sidebar').evaluate((element) => (element as HTMLElement).inert)).toBe(false);
      expect(await page.locator('main.workspace').evaluate((element) => (element as HTMLElement).inert)).toBe(false);
    } finally { await page.close(); }
  });

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
  it("opens video consultation without background requests and shields existing remote keyboard input until close",async()=>{
    const page=await openViewer({desktop:true,connected:true});
    try{
      await page.evaluate(()=>{
        const w=window as any,open=w.testApi.openFirebaseSession;
        w.testApi.openFirebaseSession=(id:string)=>new Promise(resolve=>{w.releaseVideoSession=async()=>resolve(await open(id));});
      });
      await page.locator('.table-row').filter({hasText:'PC-0'}).getByRole('button',{name:'접속',exact:true}).click();
      await page.waitForFunction(()=>Boolean((window as any).releaseVideoSession));
      const before=await page.evaluate(()=>({reads:(window as any).testState.reads,rtc:(window as any).testState.rtcStarts}));
      await page.getByRole('button',{name:'영상상담',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'휴대폰 영상상담',exact:true});await dialog.waitFor();
      expect(await page.evaluate(()=>({reads:(window as any).testState.reads,rtc:(window as any).testState.rtcStarts}))).toEqual(before);
      await page.evaluate(()=>(window as any).releaseVideoSession());
      await page.waitForFunction(()=>Boolean((window as any).rtcCallbacks));
      await page.clock.runFor(50);
      await page.evaluate(()=>(window as any).testState.controls=[]);
      await page.keyboard.press('ArrowRight');await page.keyboard.press('Control+a');
      expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual([]);
      expect(await page.locator('main.workspace').evaluate(node=>(node as HTMLElement).inert)).toBe(true);
      await dialog.getByRole('button',{name:'영상상담 닫기',exact:true}).click();
      await expect.poll(()=>page.locator('.remote-ime-input').evaluate(node=>document.activeElement===node)).toBe(true);
      await page.keyboard.press('ArrowRight');expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual(['key-down Right','key-up Right']);
    }finally{await page.close();}
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
  it("shows the fresh list immediately and marks unconfirmed manual Agents as checking", async () => {
    const page = await openViewer();
    const online = page.locator(".table-row .status-pill.online");
    const offline = page.locator(".table-row .status-pill.offline");
    try {
      await expect.poll(() => online.count()).toBe(1);
      expect(await offline.count()).toBe(9);
      await page.evaluate(() => { (window as any).refreshProgressAllOnline = true; });
      await refresh(page).click();
      await page.waitForFunction(() => typeof (window as any).finishPresenceRefresh === "function");
      await expect.poll(() => page.getByText("Fresh-PC-0", { exact: true }).count()).toBe(1);
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(10);
      expect(await online.count()).toBe(0);
      await page.evaluate(() => (window as any).emitPresenceReply());
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(9);
      expect(await online.count()).toBe(1);
      expect(await refresh(page).isEnabled()).toBe(false);
      await page.evaluate(() => (window as any).finishPresenceRefresh());
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      expect(await page.getByText("확인 중", { exact: true }).count()).toBe(0);
      expect(await online.count()).toBe(1);
      expect(await offline.count()).toBe(9);
    } finally {
      await page.close();
    }
  });

  it("keeps a failed manual presence check neutral and prevents duplicate refresh reads", async () => {
    const page = await openViewer();
    try {
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      await page.evaluate(() => {
        const w = window as any;
        w.refreshProgressAllOnline = true;
        w.testState.fail = true;
      });
      await refresh(page).click();
      await page.waitForFunction(() => typeof (window as any).finishPresenceRefresh === "function");
      for (let i = 0; i < 3; i++) await refresh(page).dispatchEvent("click");
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(10);
      await page.evaluate(() => (window as any).finishPresenceRefresh());
      await expect.poll(() => page.getByText("확인 실패", { exact: true }).count()).toBe(10);
      expect(await page.locator(".table-row .status-pill.online").count()).toBe(0);
      expect(await refresh(page).isEnabled()).toBe(true);
    } finally { await page.close(); }
  });

  it("discards late presence progress after logout", async () => {
    const page = await openViewer();
    try {
      await expect.poll(() => refresh(page).isEnabled()).toBe(true);
      await page.evaluate(() => { (window as any).refreshProgressAllOnline = true; });
      await refresh(page).click();
      await page.waitForFunction(() => typeof (window as any).finishPresenceRefresh === "function");
      await expect.poll(() => page.getByText("확인 중", { exact: true }).count()).toBe(10);
      await page.evaluate(() => (window as any).authChanged(false));
      await page.locator('input[name="username"]').waitFor();
      await page.evaluate(() => (window as any).emitPresenceReply());
      await page.evaluate(() => (window as any).finishPresenceRefresh());
      await page.evaluate(() => {
        const w = window as any;
        w.refreshProgressAllOnline = false;
        w.authChanged(true);
      });
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await page.getByText("Fresh-PC-0", { exact: true }).count()).toBe(0);
      expect(await page.getByText("확인 중", { exact: true }).count()).toBe(0);
      expect(await counts(page)).toEqual({ reads: 3, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it.each([1024, 1081, 1366, 1920])("keeps admin tools and a long Agent update result clear at %ipx", async (width) => {
    const page = await openViewer({ desktop: true, accountManager: true, viewport: { width, height: 768 }, storeName: "김미자 본오(방구석)" });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      const toolbar = page.locator(".viewer-command-header .topbar-tools");
      for (const name of ["영상상담", "Viewer 업데이트 확인", "뷰어 이전 버전 복구", "단계 배포", "계정 관리"]) {
        await toolbar.getByRole("button", { name, exact: true }).waitFor();
      }
      await page.getByRole("button", { name: /김미자 본오/ }).first().click();
      await page.getByRole("button", { name: "에이전트 업데이트 요청", exact: true }).first().click();
      await page.getByText(/PC-\d+: Agent 응답 대기 중/).waitFor();
      const failure = "업데이트 파일의 서명을 확인하지 못했습니다. 기존 버전을 유지했으며 원격 연결 설정은 변경하지 않았습니다. "
        + "장비에서 업데이트 서버에 접속할 수 있는지 확인하고 최신 서명된 설치 파일로 다시 시도해 주세요.";
      await page.evaluate(updateError => {
        const w = window as any;
        const request = w.updateRequests[0];
        const device = w.testState.devices.find((item: any) => item.id === request.id);
        w.updateWatchers[request.id].next({
          ...device, updateRequestId: request.requestId, updateState: "failed", updateError,
        });
      }, failure);
      const notice = page.getByRole("status").filter({ hasText: failure });
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
      const layout = await toolbar.evaluate(element => {
        const limits = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll<HTMLElement>(":scope > label, :scope > button")];
        const names = controls.map(control => control.getAttribute("aria-label") || control.textContent?.trim() || "search");
        const boxes = controls.map(control => control.getBoundingClientRect());
        return {
          clipped: controls.flatMap((control, index) => {
            const box = boxes[index];
            return box.width > 0 && box.left >= limits.left - 1 && box.right <= Math.min(innerWidth, limits.right + 1)
              && box.top >= limits.top - 1 && box.bottom <= limits.bottom + 1 ? [] : [names[index]];
          }),
          covered: controls.flatMap((control, index) => {
            const box = boxes[index];
            return control.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
              ? [] : [names[index]];
          }),
          overlapping: boxes.flatMap((box, index) => boxes.slice(index + 1).flatMap((other, next) =>
            box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
              ? [[names[index], names[index + next + 1]]] : [])),
        };
      });
      if (width <= 1081) await page.screenshot({ path: `../.codex-tmp/admin-toolbar-${width}.png` });
      expect(layout).toEqual({ clipped: [], covered: [], overlapping: [] });
      const consult = toolbar.getByRole("button", { name: "영상상담", exact: true });
      expect(await consult.locator("span").evaluate(label => {
        const text = document.createRange();
        text.selectNodeContents(label);
        const [line] = text.getClientRects();
        const button = label.parentElement!.getBoundingClientRect();
        return text.getClientRects().length === 1 && line.left >= button.left && line.right <= button.right;
      })).toBe(true);
      if (width === 1024) {
        await consult.click();
        await page.getByRole("dialog", { name: "휴대폰 영상상담", exact: true }).waitFor();
      }
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
        dispatch('keydown','Control','ControlLeft',{ctrlKey:true});
        dispatch('keydown','Shift','ShiftLeft',{ctrlKey:true,shiftKey:true});
        dispatch('keydown','HangulMode','Lang1',{ctrlKey:true,shiftKey:true});
        dispatch('keyup','HangulMode','Lang1');
        dispatch('keyup','Shift','ShiftLeft');
        dispatch('keyup','Control','ControlLeft');
      });
      expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual(['key-down Ctrl','key-down Shift','key-up Ctrl','key-up Shift']);
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
  it("restores the native resizable window when leaving a disconnected fullscreen session", async () => {
    const page = await openViewer({connected:true, desktop:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.locator('button[title="전체화면 전환"]').click();
      const fullscreenCalls = () => page.evaluate(() => (window as any).nativeCalls.filter((call:any) => call.command === 'plugin:window|set_fullscreen').map((call:any) => call.args.value));
      await expect.poll(fullscreenCalls).toEqual([true]);
      await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error('Disconnected')));
      const dialog = page.getByRole('dialog',{name:'원격 연결 끊김'});
      await dialog.getByRole('button',{name:'장비 목록',exact:true}).click();
      await expect.poll(fullscreenCalls).toEqual([true,false]);
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).waitFor();
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
  it.each(["during save", "after save"])("automatically commits PC received files with no overlay when the Agent completes %s", async (completionTiming) => {
    const page = await openViewer({connected:true,desktop:true});
    try {
      await page.getByText("PC-0",{exact:true}).waitFor();
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})}).getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => Boolean((window as any).rtcCallbacks));
      await page.evaluate(() => {
        const w = window as any;
        w.holdNativeSave = true;
        w.rtcCallbacks.onFileStatus({type:"file-status",requestId:"native-auto",state:"sending"});
      });
      await page.getByText("원격 파일 수신 중",{exact:true}).waitFor();
      const text="local automatic save", sha=createHash("sha256").update(text).digest("hex");
      await page.evaluate(chunk=>(window as any).rtcCallbacks.onFileChunk(chunk,()=>true),{type:"file-chunk",transferId:"native-auto",filename:"received.txt",chunkIndex:0,totalChunks:1,totalBytes:Buffer.byteLength(text),isLast:true,fileData:Buffer.from(text).toString("base64"),chunkSha256:sha,fileSha256:sha});
      const receiveCompletion = () => page.evaluate(async () => {
        (window as any).rtcCallbacks.onFileStatus({type:"file-status",requestId:"native-auto",state:"complete"});
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const overlay = page.locator(".session-transfer-progress");
      await page.getByRole("complementary",{name:"파일 전송 목록"}).getByText("검증 및 저장 중 · 99%",{exact:true}).waitFor();
      await page.waitForFunction(() => typeof (window as any).releaseNativeSave === "function");
      expect(await overlay.count()).toBe(0);
      if (completionTiming === "during save") {
        await receiveCompletion();
        expect(await overlay.count()).toBe(0);
      }
      await page.evaluate(() => (window as any).releaseNativeSave());
      await page.getByText("완료 · 100% · C:/Downloads/received.txt",{exact:true}).waitFor();
      if (completionTiming === "after save") await receiveCompletion();
      expect(await overlay.count()).toBe(0);
      expect(await page.getByRole("button",{name:"받은 파일 저장",exact:true}).count()).toBe(0);
      await page.getByRole("button",{name:"다운로드 받은 파일 열기",exact:true}).click();
      await page.getByRole("button",{name:"내 PC 받은 폴더 열기",exact:true}).click();
      await page.getByRole("button",{name:"기본 다운로드 폴더 설정",exact:true}).click();
      const result=await page.evaluate(()=>({calls:(window as any).nativeCalls,chunks:(window as any).nativeChunks,controls:(window as any).testState.controls}));
      expect(result.calls.filter((x:any)=>x.command==="finish_viewer_download")).toHaveLength(1);
      expect(result.calls).toContainEqual({command:"open_viewer_download_file",args:{path:"C:/Downloads/received.txt"}});
      expect(result.calls.map((x:any)=>x.command)).toContain("open_viewer_download_folder");
      expect(result.calls.map((x:any)=>x.command)).toContain("choose_viewer_download_folder");
      expect(result.controls).not.toContain("open-download-folder");
      expect(Buffer.from(result.chunks.join(""),"base64").toString()).toBe(text);
    } finally { await page.close(); }
  });
  it("negotiates collision choices without extra reads and never retries an explicit skip through Storage", async () => {
    const page = await openViewer({ connected: true, desktop: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => Boolean((window as any).rtcCallbacks));
      await page.evaluate(() => {
        const w = window as any;
        w.sentPolicy = []; w.storageUploads = 0;
        w.testSendFile = async (input: any) => { w.sentPolicy.push(input.collisionPolicy); throw Error("File skipped: same.txt (existing file preserved)"); };
        w.testApi.uploadFirebaseFileToStorage = async () => { w.storageUploads++; throw Error("Unexpected fallback"); };
        w.rtcCallbacks.onFileCollisionSupport();
      });
      // A completed receive exposes the existing transfer panel; its default stays safe.
      const text = "first", sha = createHash("sha256").update(text).digest("hex");
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), {
        type: "file-chunk", transferId: "policy-initial", filename: "first.txt", chunkIndex: 0, totalChunks: 1,
        totalBytes: text.length, isLast: true, fileData: Buffer.from(text).toString("base64"), chunkSha256: sha, fileSha256: sha,
      });
      await page.getByText("완료 · 100% · C:/Downloads/received.txt", { exact: true }).waitFor();
      const before = await counts(page);
      const choice = page.getByRole("combobox", { name: "동명 파일 처리" });
      expect(await choice.inputValue()).toBe("rename");
      await choice.selectOption("overwrite"); await choice.selectOption("rename"); await choice.selectOption("skip");
      expect(await counts(page)).toEqual(before);
      await page.locator(".session-panel").locator('input[type="file"]').first().setInputFiles({ name: "same.txt", mimeType: "text/plain", buffer: Buffer.from("new") });
      await page.waitForFunction(() => (window as any).sentPolicy.length === 1);
      expect(await page.evaluate(() => ({ policy: (window as any).sentPolicy, fallback: (window as any).storageUploads }))).toEqual({ policy: ["skip"], fallback: 0 });
      await page.getByText("건너뜀", { exact: true }).waitFor();
      await page.screenshot({ path: "../.codex-tmp/release-prep-collision-desktop.png" });
      await page.setViewportSize({ width: 360, height: 800 });
      expect(await page.locator(".session-transfer-queue-heading").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: "../.codex-tmp/release-prep-collision-mobile.png" });
      await page.evaluate(() => (window as any).rtcCallbacks.onState("webrtc-file-closed"));
      await page.getByText("전송: 기존 방식", { exact: true }).waitFor();
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
      await panel.getByLabel("화면 반응 속도: 빠름", {exact:true}).waitFor();
      expect(await page.evaluate(() => (window as any).readOriginalPreference("wonremote-device-view:device-0"))).toBe(await page.evaluate(() => (window as any).savedPreferenceFixture));
      await page.getByText("기기 설정을 저장하지 못했습니다. 현재 연결에는 적용되지만 다음 접속에는 유지되지 않을 수 있습니다.", { exact: true }).waitFor();
      await page.getByTestId("end-session").click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).restorePreferenceStorage());
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await panel.getByLabel("화면 반응 속도: 빠름", {exact:true}).waitFor();
      expect(await page.getByText("기기 설정을 저장하지 못했습니다. 현재 연결에는 적용되지만 다음 접속에는 유지되지 않을 수 있습니다.", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  });
  it("keeps a first-use monitor selection and restores it after reconnect", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => {
        const device = (window as any).testState.devices[0];
        device.displays = [0, 1].map(index => ({ index, name: `Monitor ${index}`, x: index * 1920, y: 0, width: 1920, height: 1080, primary: index === 0 }));
        device.activeDisplayIndex = 1;
      });
      await refresh(page).click();
      const connect = () => page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await connect();
      const select = page.getByRole("combobox", { name: "모니터 선택", exact: true });
      await expect.poll(() => select.inputValue()).toBe("1");
      await page.clock.pauseAt(new Date(Date.now()+1_000));
      await page.locator('.remote-canvas').evaluate(canvas=>{
        const w=window as any;w.testState.controls=[];
        canvas.getBoundingClientRect=()=>new DOMRect(0,0,100,100);
        canvas.setPointerCapture=()=>{}; canvas.hasPointerCapture=()=>false;
        w.emitMonitorPointer=(clientX:number,type='pointermove')=>canvas.dispatchEvent(new PointerEvent(type,{pointerType:'mouse',pointerId:1,button:0,buttons:type==='pointerdown'?1:0,clientX,clientY:50,bubbles:true}));
        w.emitMonitorPointer(50);
        w.emitMonitorPointer(100);
      });
      await select.selectOption("0");
      await expect.poll(() => select.inputValue()).toBe("0");
      await page.clock.runFor(20);
      expect(await page.evaluate(()=>(window as any).testState.controls)).toEqual(['move 49151 32768','switch-monitor 0']);
      await page.evaluate(()=>(window as any).emitMonitorPointer(50));
      expect(await page.evaluate(()=>(window as any).testState.controls.at(-1))).toBe('move 16384 32768');
      await page.evaluate(()=>{
        const w=window as any;
        w.emitMonitorPointer(50,'pointerdown');
        w.emitMonitorPointer(50,'pointerup');
      });
      expect(await page.evaluate(()=>(window as any).testState.controls.slice(-2))).toEqual(['mouse-down 16384 32768 left','mouse-up 16384 32768 left']);
      await page.clock.resume();
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
      expect(saved).toMatchObject({ zoom: mobile ? 1 : 2, streamPerformanceMode: "fast", inputMode: "touchpad" });
      if (mobile) await page.screenshot({ path: `.local-run/width-fit-${width}.png` });
    } finally { await page.close(); }
  });
  it.each([{width:390,height:844},{width:844,height:390}])("preserves mobile magnification through IME viewport resize at $width x $height", async viewport => {
    const page = await openViewer({connected:true,mobile:true,emulateMobile:true,viewport});
    try {
      await page.evaluate(portrait => Object.defineProperty(screen.orientation, "type", {configurable:true,value:portrait ? "portrait-primary" : "landscape-primary"}), viewport.height > viewport.width);
      await page.getByText("PC-0", {exact:true}).waitFor();
      await page.locator(".table-row").filter({has:page.getByText("PC-0", {exact:true})}).getByRole("button", {name:"접속",exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const image = document.createElement("canvas"); image.width=1920; image.height=1080;
        const context=image.getContext("2d")!;
        context.fillStyle="#286550";context.fillRect(0,0,1920,1080);
        context.fillStyle="#fff";context.fillRect(320,0,32,1080);context.fillRect(0,240,1920,32);
        (window as any).rtcCallbacks.onFrame({keyframe:true,width:1920,height:1080,tiles:[{x:0,y:0,w:1920,h:1080,data:image.toDataURL("image/jpeg").split(",")[1]}]});
      });
      const canvas = page.locator(".remote-canvas");
      await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBe(1920);
      const controls = page.locator(".mobile-remote-controls");
      for(let i=0;i<6;i++) await controls.getByRole("button",{name:"확대",exact:true}).click();
      const dimensions = () => canvas.evaluate(node => ({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,scale:new DOMMatrix(getComputedStyle(node).transform).a}));
      const before = await dimensions();
      expect(before.scale).toBeCloseTo(1.3);
      await controls.getByRole("button",{name:"키보드",exact:true}).click();
      await page.setViewportSize({width:viewport.width,height:Math.max(180,viewport.height-260)});
      await expect.poll(dimensions).toEqual(before);
      await page.locator('[data-remote-ime-input="true"]').evaluate(node => (node as HTMLElement).blur());
      await page.setViewportSize(viewport);
      await expect.poll(dimensions).toEqual(before);
      expect(await page.evaluate(() => (window as any).testState.rtcStarts)).toBe(1);
      await page.screenshot({path:`../.codex-tmp/ime-zoom-${viewport.width}.png`});
    } finally { await page.close(); }
  });
  it("always starts two PCs in fast mode and removes auto/normal choices", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => {
        localStorage.setItem("wonremote-stream-performance-mode", "normal");
        localStorage.setItem("wonremote-device-view:device-0", JSON.stringify({ streamPerformanceMode: "auto" }));
      });
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      const panel = page.locator(".session-panel:not(.session-panel-inactive)");
      await panel.getByLabel("화면 반응 속도: 빠름", {exact:true}).waitFor();
      expect(await panel.getByRole("button", {name:"자동",exact:true}).count()).toBe(0);
      expect(await panel.getByRole("button", {name:"보통",exact:true}).count()).toBe(0);
      await page.waitForFunction(() => (window as any).testState.controls.includes("set-stream-mode fast"));
      await panel.getByRole("button", { name: "장비 목록", exact: true }).click();
      await page.locator(".table-row").filter({ has: page.getByText("PC-1", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await panel.getByLabel("화면 반응 속도: 빠름", {exact:true}).waitFor();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-1")!).streamPerformanceMode === "fast");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wonremote-device-view:device-0")!).streamPerformanceMode)).toBe("fast");
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
      expect(await panel.locator('.session-transfer-progress').count()).toBe(0);
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
      const transferList = panel.getByRole('complementary', {name:'파일 전송 목록'});
      await transferList.getByRole('button', {name:'완료 항목 정리', exact:true}).click();
      await transferList.waitFor({state:'detached'});
      expect(await panel.locator('.session-transfer-progress').count()).toBe(0);
    } finally { await page.close(); }
  });

  it("pauses, resumes, and separately cancels an outgoing transfer", async () => {
    const page = await openViewer({ connected: true, desktop: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.evaluate(() => {
        const w = window as any;
        w.outgoingAttempts = [];
        w.outgoingAborts = 0;
        w.testSendFile = (input: any) => {
          w.outgoingAttempts.push({ resume: input.resume === true, transferId: input.transferId });
          input.onProgress?.(Math.min(32768, input.file.size), input.file.size);
          return new Promise<boolean>((resolve, reject) => {
            const abort = () => {
              w.outgoingAborts += 1;
              reject(new DOMException("File transfer cancelled.", "AbortError"));
            };
            input.signal.addEventListener("abort", abort, { once: true });
            w.finishOutgoing = () => {
              input.signal.removeEventListener("abort", abort);
              input.onProgress?.(input.file.size, input.file.size);
              resolve(true);
            };
          });
        };
      });
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      const panel = page.getByTestId("remote-session-workspace");
      const fileInput = panel.locator('input[type="file"]').first();

      await fileInput.setInputFiles({ name: "outgoing.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(65536, 65) });
      const outgoingRow = panel.locator(".session-transfer-queue-item").filter({ hasText: "outgoing.bin" });
      await panel.getByRole("button", { name: "파일 전송 일시중단", exact: true }).click();
      await expect.poll(() => outgoingRow.innerText()).toContain("일시중단됨");
      await page.screenshot({ path: ".local-run/outgoing-paused-desktop.png" });
      expect(await page.evaluate(() => (window as any).outgoingAttempts)).toHaveLength(1);
      expect(await page.evaluate(() => (window as any).outgoingAborts)).toBe(1);

      await panel.getByRole("button", { name: "파일 전송 이어받기", exact: true }).click();
      await page.waitForFunction(() => (window as any).outgoingAttempts.length === 2);
      const attempts = await page.evaluate(() => (window as any).outgoingAttempts);
      expect(attempts[1]).toEqual({ resume: true, transferId: attempts[0].transferId });
      await page.evaluate(() => (window as any).finishOutgoing());
      await expect.poll(() => outgoingRow.innerText()).toContain("완료");

      await fileInput.setInputFiles({ name: "cancel.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(65536, 66) });
      const cancelRow = panel.locator(".session-transfer-queue-item").filter({ hasText: "cancel.bin" });
      await cancelRow.getByRole("button", { name: "파일 전송 취소", exact: true }).click();
      await expect.poll(() => cancelRow.innerText()).toContain("취소됨");
      expect(await page.evaluate(() => (window as any).outgoingAborts)).toBe(2);
      expect(await cancelRow.getByRole("button", { name: "재시도", exact: true }).count()).toBe(1);
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
      expect(await page.locator(".device-update-options").evaluate(section=>{
        const pause=section.querySelector("label")!.getBoundingClientRect();
        const rollback=section.querySelector("button")!.getBoundingClientRect();
        return rollback.top>=pause.bottom && rollback.top-pause.bottom<=10;
      })).toBe(true);
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
  it("adds and edits reusable tags beside Kiosk selection without saving the device early", async () => {
    const page=await openViewer({viewport:{width:1024,height:768}});
    try {
      await page.getByText("PC-0", {exact:true}).waitFor();
      const consultation = page.getByRole("button",{name:"영상상담",exact:true});
      expect(await consultation.evaluate(button=>{
        const range=document.createRange();range.selectNodeContents(button.querySelector("span")!);
        return range.getClientRects().length===1 && button.getBoundingClientRect().right<=innerWidth;
      })).toBe(true);
      await page.evaluate(()=>{const w=window as any;w.metaCalls=[];w.testApi.updateFirebaseDeviceMetadata=async(id:string,input:any)=>{
        w.metaCalls.push(input);const device=w.testState.devices.find((item:any)=>item.id===id);
        Object.assign(device,Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined)));return device;
      };});
      const edit=()=>page.locator(".table-row").filter({has:page.getByText(/\bAGENT-0\b/)}).getByRole("button",{name:"장비 정보 수정",exact:true}).click();
      await edit();
      const dialog=page.getByRole("dialog",{name:"등록 장비 수정",exact:true});
      const type=dialog.getByLabel("장비 종류",{exact:true});
      const values=await type.locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value));
      expect(values).toEqual(["메인포스","오더포스","키오스크","태블릿","custom"]);
      await type.selectOption("키오스크");
      await dialog.getByRole("button",{name:"자주 쓰는 태그 만들기",exact:true}).click();
      await dialog.getByLabel("태그 이름",{exact:true}).fill("긴급");
      await dialog.getByLabel("태그 색상",{exact:true}).fill("#bb2200");
      await dialog.getByRole("button",{name:"태그 편집 저장",exact:true}).click();
      await dialog.getByRole("button",{name:"긴급 태그 편집",exact:true}).click();
      await dialog.getByLabel("태그 이름",{exact:true}).fill("현장지원");
      await dialog.getByLabel("태그 색상",{exact:true}).fill("#129284");
      await dialog.getByRole("button",{name:"태그 편집 저장",exact:true}).click();
      await dialog.getByRole("button",{name:"현장지원 태그 추가",exact:true}).click();
      expect(await dialog.getByLabel("태그",{exact:true}).inputValue()).toBe("현장지원");
      expect(await dialog.getByRole("button",{name:"현장지원 태그 추가",exact:true}).isDisabled()).toBe(true);
      expect(await page.evaluate(()=>(window as any).metaCalls)).toEqual([]);
      await page.screenshot({path:"../.codex-tmp/viewer-operations-tag-editor.png"});
      await dialog.getByRole("button",{name:"저장",exact:true}).click();
      await dialog.waitFor({state:"detached"});
      expect(await page.evaluate(()=>(window as any).metaCalls[0])).toMatchObject({deviceName:"키오스크",tags:["현장지원"]});
      await edit();
      expect(await type.inputValue()).toBe("키오스크");
      expect(await dialog.getByRole("button",{name:"현장지원 태그 추가",exact:true}).locator("i").evaluate(i=>getComputedStyle(i).backgroundColor)).toBe("rgb(18, 146, 132)");
    } finally { await page.close(); }
  });
  it("reveals mobile reverse transfer when the Android bridge attaches after the session renders", async () => {
    const page=await openViewer({connected:true,mobile:true,nativeAndroid:true,emulateMobile:true});
    try {
      await page.getByText("PC-0",{exact:true}).waitFor();
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})}).getByRole("button",{name:"접속",exact:true}).click();
      await page.locator(".mobile-remote-controls").getByRole("button",{name:"화면 및 세션 설정",exact:true}).click();
      await page.evaluate(()=>(window as any).rtcCallbacks.onReverseFileSupport());
      const button=page.getByRole("button",{name:"원격 파일 가져오기",exact:true});
      expect(await button.count()).toBe(0);
      const before=await counts(page);
      await page.evaluate(() => {
        const channel=new MessageChannel();
        window.dispatchEvent(new MessageEvent("message",{data:"wonremote:file-export:1",origin:"",source:null,ports:[channel.port2]}));
      });
      await expect.poll(()=>button.count()).toBe(1);
      await page.screenshot({path:"../.codex-tmp/android-late-bridge.png"});
      await button.waitFor();expect(await button.isEnabled()).toBe(true);
      await button.click();
      expect(await page.evaluate(()=>(window as any).testState.controls.filter((action:string)=>action==="request-file-send"))).toEqual(["request-file-send"]);
      expect(await counts(page)).toEqual(before);
    } finally {await page.close();}
  });
  it("uploads Android-selected binary files intact and waits for remote save confirmation", async () => {
    const page=await openViewer({connected:true,mobile:true,nativeAndroid:true,emulateMobile:true});
    const bytes=Buffer.alloc(70001);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    try {
      await page.getByText("PC-0",{exact:true}).waitFor();
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})}).getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(()=>Boolean((window as any).rtcCallbacks));
      await page.evaluate(()=>{
        const w=window as any;w.uploads=[];w.fallbacks=0;
        w.testSendFile=async(input:any)=>{
          const data=new Uint8Array(await input.file.arrayBuffer());
          w.uploads.push({name:input.filename,sha:input.fileSha256,bytes:btoa(String.fromCharCode(...data))});
          input.onProgress(input.file.size,input.file.size);
          return await new Promise(resolve=>{w.finishMobileUpload=()=>resolve(true);});
        };
        w.testApi.uploadFirebaseFileToStorage=async()=>{w.fallbacks++;throw Error("Unexpected fallback");};
      });
      await page.locator('.session-panel input[type="file"]').first().setInputFiles({name:"전화기.bin",mimeType:"application/octet-stream",buffer:bytes});
      await page.waitForFunction(()=>typeof (window as any).finishMobileUpload==="function");
      expect(await page.getByText("완료",{exact:true}).count()).toBe(0);
      expect(await page.evaluate(()=>(window as any).uploads)).toEqual([{name:"전화기.bin",sha:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.toString("base64")}]);
      await page.evaluate(()=>(window as any).finishMobileUpload());
      await page.getByText("완료",{exact:true}).waitFor();
      expect(await page.evaluate(()=>(window as any).fallbacks)).toBe(0);
    } finally {await page.close();}
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
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport());
      await page.getByTestId("secondary-tools").locator("summary").click();
      expect(await page.getByRole("button",{name:"원격 파일 가져오기",exact:true}).isEnabled()).toBe(true);
      const nextContents="second Android file", nextSha=createHash("sha256").update(nextContents).digest("hex");
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk,()=>true), {
        type:"file-chunk", transferId:"android-next", filename:"second.txt", chunkIndex:0,totalChunks:1,
        totalBytes:Buffer.byteLength(nextContents),isLast:true,fileData:Buffer.from(nextContents).toString("base64"),chunkSha256:nextSha,fileSha256:nextSha,
      });
      await page.getByText("second.txt",{exact:true}).waitFor();
    } finally { await page.close(); }
  });
  it("starts remote file selection without duplicating transfer cancellation in the PC tools menu", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByTestId("secondary-tools").locator("summary").click();
      expect(await page.getByRole("button", { name: "원격 파일 가져오기", exact: true }).isDisabled()).toBe(true);
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport());
      await page.getByRole("button", { name: "원격 파일 가져오기", exact: true }).click();
      expect(await page.getByRole("button", { name: "가져오기 취소", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => (window as any).testState.controls.filter((value: string) => value.endsWith("file-send"))))
        .toEqual(["request-file-send"]);
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "reverse-ui", state: "selecting" }));
      await page.getByRole("status").filter({ hasText: "원격 PC에서 파일 선택 중" }).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "reverse-ui", state: "selection-failed" }));
      await page.getByText("원격 파일 선택 창을 열지 못했습니다. 로그인된 사용자 화면을 확인해 주세요.", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).rtcCallbacks.onState("webrtc-file-closed"));
      await page.getByTestId("secondary-tools").locator("summary").click();
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
      expect(await page.getByRole("button", { name: "파일 수신 일시중단", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByRole("button", { name: "파일 수신 취소", exact: true }).isEnabled()).toBe(true);
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
  it("pauses, resumes, cancels and hides an incoming transfer without deleting it on panel close", async () => {
    const page = await openViewer({ connected: true });
    const first = Buffer.alloc(32768, 65), second = Buffer.alloc(32768, 66);
    const chunk = (index: number, bytes: Buffer) => ({
      type: "file-chunk", transferId: "controls-ui", filename: "controls.bin", totalBytes: 65537,
      totalChunks: 3, chunkIndex: index, isLast: false, fileData: bytes.toString("base64"),
      chunkSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFileChunk === "function");
      await page.evaluate(() => (window as any).rtcCallbacks.onReverseFileSupport(true));
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk(0, first));
      const progress = page.getByRole("progressbar", { name: "파일 수신 진행률" });
      await progress.waitFor();
      expect(await progress.locator("..").innerText()).toContain("49%");
      await page.getByRole("button", { name: "파일 전송 목록 닫기", exact: true }).click();
      await progress.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "파일 전송 목록 열기", exact: true }).click();
      await page.getByRole("button", { name: "파일 수신 일시중단", exact: true }).click();
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "controls-ui", state: "cancelled" }));
      await page.getByText(/수신 중단됨/).waitFor();
      await page.getByRole("button", { name: "중단된 수신 이어받기", exact: true }).click();
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "controls-ui", state: "sending" }));
      await page.evaluate(chunk => (window as any).rtcCallbacks.onFileChunk(chunk, () => true), chunk(1, second));
      await expect.poll(() => progress.locator("..").innerText()).toContain("99%");
      await page.getByRole("button", { name: "파일 수신 취소", exact: true }).click();
      await page.evaluate(() => (window as any).rtcCallbacks.onFileStatus({ type: "file-status", requestId: "controls-ui", state: "cancelled" }));
      await progress.waitFor({ state: "detached" });
      expect(await page.getByRole("button", { name: "중단된 수신 이어받기", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => (window as any).testState.controls.filter((value: string) => value === "cancel-file-send" || value.startsWith("request-file-resume"))))
        .toEqual(["cancel-file-send", "request-file-resume controls-ui", "cancel-file-send"]);
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
  it("commits the complete first picture without staging a full surface or exposing partial tiles", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.getByText("Store · 화면 수신 대기",{exact:true}).waitFor();
      await page.evaluate(() => {
        const w = window as any;
        const canvas = document.querySelector<HTMLCanvasElement>(".remote-canvas")!;
        canvas.width = 64; canvas.height = 32;
        const visible = canvas.getContext("2d",{willReadFrequently:true})!;
        visible.fillStyle = "#ff00ff"; visible.fillRect(0,0,1,1);
        w.firstPictureDraws = [];
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(this: CanvasRenderingContext2D, ...args: unknown[]) {
          w.firstPictureDraws.push([this.canvas === canvas, args[0] instanceof HTMLImageElement]);
          if (w.failFirstPictureDraw && this.canvas === canvas && args[1] === 32) throw new Error("simulated visible canvas draw failure");
          return Reflect.apply(draw,this,args);
        };
        const tiles = ["#ff0000", "#0000ff"].map((color,x) => {
          const source = document.createElement("canvas"); source.width = source.height = 32;
          const ctx = source.getContext("2d")!;
          ctx.fillStyle = color; ctx.fillRect(x === 0 ? 1 : 0,0,32,32);
          return {x,y:0,w:32,h:32,data:source.toDataURL("image/png").split(",")[1]};
        });
        let allocated = 0;
        const createElement = document.createElement.bind(document);
        document.createElement = ((name: string, options?: ElementCreationOptions) => {
          if (name === "canvas") allocated++;
          return createElement(name, options);
        }) as typeof document.createElement;
        w.sendFirstPicture = (invalid: boolean) => w.rtcCallbacks.onFrame({width:64,height:32,keyframe:true,
          tiles:invalid?[tiles[0],{...tiles[1],data:"bad-tile"}]:tiles});
        w.readFirstPicture = () => ({
          pixels:[0,1,63].map(x=>Array.from(visible.getImageData(x,0,1,1).data)),draws:w.firstPictureDraws,allocated,
        });
        w.sendFirstPicture(true);
      });
      const read = () => page.evaluate(() => (window as any).readFirstPicture());
      await page.getByText("Store · 화면 표시 오류",{exact:true}).waitFor();
      expect(await read()).toEqual({pixels:[[255,0,255,255],[0,0,0,0],[0,0,0,0]],draws:[],allocated:0});
      await page.evaluate(() => {
        const w = window as any;
        w.failFirstPictureDraw = true; w.sendFirstPicture(false);
      });
      await page.waitForFunction(() => (window as any).firstPictureDraws.length === 2);
      const emptyPixels = [[0,0,0,0],[0,0,0,0],[0,0,0,0]];
      expect((await read()).pixels).toEqual(emptyPixels);
      await page.evaluate(() => {
        const w = window as any;
        w.failFirstPictureDraw = false; w.firstPictureDraws = [];
        const NativeImage = window.Image;
        let count = 0;
        (window as any).Image = function () {
          const img = new NativeImage();
          if (++count === 2) {
            window.Image = NativeImage;
            Object.defineProperty(img,"onload",{set(callback) {
              img.addEventListener("load",() => { (window as any).releaseFirstPictureTile = () => callback.call(img); },{once:true});
            }});
          }
          return img;
        };
        (window as any).sendFirstPicture(false);
      });
      await page.waitForFunction(() => typeof (window as any).releaseFirstPictureTile === "function");
      expect(await read()).toEqual({pixels:emptyPixels,draws:[],allocated:0});
      await page.evaluate(() => (window as any).releaseFirstPictureTile());
      await page.getByText("Store · 화면 수신 중",{exact:true}).waitFor();
      expect(await read()).toEqual({pixels:[[0,0,0,0],[255,0,0,255],[0,0,255,255]],draws:[[true,true],[true,true]],allocated:0});
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
  it("draws a complete picture without per-cell sequence writes and preserves newer pixels", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === 'function');
      await page.evaluate(() => {
        const w = window as any;
        w.drawCalls = 0;
        w.cellSequenceWrites = 0;
        w.cellSequenceKeys = [];
        const set = Map.prototype.set;
        Map.prototype.set = function(key: unknown, value: unknown) {
          const cells = (typeof key === 'string' && /^\d+:\d+$/.test(key)) || Number.isSafeInteger(key);
          if (cells && [9,10,11,12,999].includes(value as number)) {
            w.cellSequenceWrites++;
            w.cellSequenceKeys.push(key);
          }
          return set.call(this, key, value);
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(this: CanvasRenderingContext2D, ...args: unknown[]) {
          if (args[0] instanceof HTMLImageElement) w.drawCalls++;
          return Reflect.apply(draw, this, args);
        };
        w.drawRemoteTile = (sequence: number, width: number, color: string, x = 0) => {
          const height = sequence === 10 ? 1080 : 64;
          const source = document.createElement('canvas');
          source.width = width; source.height = height;
          const ctx = source.getContext('2d')!;
          ctx.fillStyle = color; ctx.fillRect(0,0,width,height);
          w.rtcCallbacks.onFrame({sequence, keyframe:sequence===10, width:1920, height:1080,
            tiles:[{x, y:0, w:width, h:height, data:source.toDataURL('image/jpeg').split(',')[1]}]});
        };
      });
      const canvas = page.locator('.remote-canvas');
      const pixel = (x:number, y:number, channel:number) => canvas.evaluate((node, point) =>
        (node as HTMLCanvasElement).getContext('2d')!.getImageData(point.x,point.y,1,1).data[point.channel], {x,y,channel});
      const send = (sequence:number,width:number,color:string,x=0) => page.evaluate(params => (window as any).drawRemoteTile(...params), [sequence,width,color,x]);
      const drawCalls = () => page.evaluate(() => (window as any).drawCalls);
      await send(10,1920,'#ff0000');
      await expect.poll(() => pixel(1919,1079,0)).toBeGreaterThan(240);
      expect(await drawCalls()).toBe(1);
      expect(await page.evaluate(() => (window as any).cellSequenceWrites)).toBe(0);
      const holdDecodedTile = (key: string) => page.evaluate(key => {
        const NativeImage = window.Image;
        (window as any).Image = function() {
          window.Image = NativeImage;
          const img = new NativeImage();
          Object.defineProperty(img,'onload',{set(callback) {
            img.addEventListener('load',() => { (window as any)[key] = () => callback.call(img); },{once:true});
          }});
          return img;
        };
      },key);
      await holdDecodedTile('resumeBeforeBaseline');
      await send(9,64,'#ffffff',4);
      await page.waitForFunction(() => Boolean((window as any).resumeBeforeBaseline));
      await page.evaluate(() => (window as any).resumeBeforeBaseline());
      expect(await pixel(128,0,1)).toBeLessThan(10);
      expect(await drawCalls()).toBe(1);
      await holdDecodedTile('resumeInvalidTile');
      await send(999,64,'#ffffff',60);
      await page.waitForFunction(()=>Boolean((window as any).resumeInvalidTile));
      await page.evaluate(()=>(window as any).resumeInvalidTile());
      await holdDecodedTile('resumeOldTile');
      await send(11,96,'#0000ff');
      await page.waitForFunction(()=>Boolean((window as any).resumeOldTile));
      await send(12,64,'#00ff00');
      await expect.poll(() => pixel(63,63,1)).toBeGreaterThan(240);
      expect(await drawCalls()).toBe(2);
      expect(await page.evaluate(() => (window as any).cellSequenceWrites)).toBe(4);
      await page.evaluate(()=>(window as any).resumeOldTile());
      await expect.poll(() => pixel(95,63,2)).toBeGreaterThan(240);
      expect(await pixel(0,0,1)).toBeGreaterThan(240);
      expect(await pixel(63,63,1)).toBeGreaterThan(240);
      expect(await pixel(1919,1079,0)).toBeGreaterThan(240);
      expect(await drawCalls()).toBe(4);
      expect(await page.evaluate(() => (window as any).cellSequenceWrites)).toBe(6);
      expect(await page.evaluate(() => (window as any).cellSequenceKeys)).toEqual([0,1,60,61,2,62]);
    } finally { await page.close(); }
  });
  it("replaces a same-size picture without resetting the remote canvas, then applies deltas and a real resize", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        w.remoteSizeWrites = [];
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          const source = args[0];
          if (source instanceof HTMLCanvasElement && this.canvas.classList.contains("remote-canvas")) {
            w.lastStagingContext = source.getContext("2d");
          }
          Reflect.apply(drawImage, this, args);
        };
        for (const key of ["width", "height"]) {
          const dimension = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key)!;
          Object.defineProperty(HTMLCanvasElement.prototype,key,{...dimension,set(this: HTMLCanvasElement,value: number) {
            if (this.classList.contains("remote-canvas")) w.remoteSizeWrites.push(key);
            dimension.set!.call(this,value);
          }});
        }
        w.sendResizeFrame = (sequence:number) => {
          const width = sequence === 8 ? 192 : sequence === 9 ? 160 : 128, height = 64;
          const jpeg = sequence === 4 || sequence === 6 || sequence === 7;
          const tile = document.createElement("canvas");
          tile.width = sequence === 3 ? 32 : width;
          tile.height = sequence === 3 ? 32 : height;
          const ctx = tile.getContext("2d")!;
          ctx.fillStyle = ["", "#ff0000", "#0000ff", "#ffff00", "#00ff00", "#ff0000", "#0000ff", "#ff0000", "#0000ff", "#00ff00"][sequence];
          ctx.fillRect(sequence === 2 ? 32 : sequence === 5 ? 64 : 0,0,tile.width,tile.height);
          w.rtcCallbacks.onFrame({sequence,width,height,keyframe:sequence!==3&&!jpeg,
            tiles:[{x:0,y:0,w:tile.width,h:tile.height,data:tile.toDataURL(jpeg ? "image/jpeg" : "image/png").split(",")[1]}]});
        };
      });
      const canvas = page.locator(".remote-canvas");
      const send = (sequence:number) => page.evaluate(sequence => (window as any).sendResizeFrame(sequence),sequence);
      const pixel = (x:number, y:number) => canvas.evaluate((node,{x,y}) =>
        Array.from((node as HTMLCanvasElement).getContext("2d")!.getImageData(x,y,1,1).data),{x,y});
      await send(1);
      await expect.poll(() => pixel(1,1)).toEqual([255,0,0,255]);
      await page.evaluate(() => { (window as any).remoteSizeWrites = []; });
      await send(2);
      await expect.poll(() => pixel(100,40)).toEqual([0,0,255,255]);
      expect(await pixel(1,1)).toEqual([0,0,0,0]);
      expect(await page.evaluate(() => (window as any).remoteSizeWrites)).toEqual([]);
      await send(3);
      await expect.poll(() => pixel(1,1)).toEqual([255,255,0,255]);
      expect(await pixel(100,40)).toEqual([0,0,255,255]);
      await send(4);
      await expect.poll(async () => (await pixel(100,40))[1]).toBeGreaterThan(250);
      await page.evaluate(() => {
        const w = window as any;
        w.jpegStagingContext = w.lastStagingContext;
      });
      await send(5);
      await expect.poll(() => pixel(100,40)).toEqual([255,0,0,255]);
      expect(await pixel(40,1)).toEqual([0,0,0,0]);
      expect(await page.evaluate(() => {
        const w = window as any;
        return !!w.jpegStagingContext && w.lastStagingContext === w.jpegStagingContext;
      })).toBe(true);
      expect(await page.evaluate(() => (window as any).remoteSizeWrites)).toEqual([]);
      await send(6);
      await expect.poll(async () => (await pixel(100,40))[2]).toBeGreaterThan(250);
      await page.evaluate(() => {
        const staging: CanvasRenderingContext2D = (window as any).lastStagingContext;
        staging.isContextLost = () => true;
        staging.drawImage = () => {};
        staging.clearRect = () => {};
      });
      await send(7);
      await expect.poll(async () => (await pixel(100,40))[0]).toBeGreaterThan(250);
      const lastGoodPixel = await pixel(100,40);
      await page.evaluate(() => {
        const staging: CanvasRenderingContext2D = (window as any).lastStagingContext;
        staging.drawImage = () => { staging.isContextLost = () => true; };
      });
      await send(8);
      const reconnect = page.getByRole("button",{name:"원격 연결 새로고침"});
      await expect.poll(() => reconnect.isEnabled()).toBe(true);
      expect(await pixel(100,40)).toEqual(lastGoodPixel);
      expect(await page.evaluate(() => (window as any).remoteSizeWrites)).toEqual([]);
      await send(9);
      await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBe(160);
      await expect.poll(() => reconnect.isEnabled()).toBe(false);
      expect(await pixel(159,63)).toEqual([0,255,0,255]);
      expect(await page.evaluate(() => (window as any).remoteSizeWrites)).toEqual(["width"]);
    } finally { await page.close(); }
  });
  it.each(["same-size", "corrupt", "delta", "resize", "legacy-resize", "covered-delta", "corrupt-covered-delta", "mixed-corrupt-covered-delta", "covered-delta-background", "newer-partial-delta"])("prioritizes the newest queued full picture and preserves boundaries (%s)", async scenario => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.getByText("Store · 화면 수신 대기",{exact:true}).waitFor();
      await page.evaluate(() => {
        const w = window as any;
        const tile = (width: number, color: string, x: number, jpeg: boolean) => {
          const source = document.createElement("canvas"); source.width = width; source.height = 32;
          const ctx = source.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0,0,width,32);
          return {x,y:0,w:width,h:32,data:source.toDataURL(jpeg?"image/jpeg":"image/png").split(",")[1]};
        };
        w.sendKeyframeBurst = (sequence: number | undefined, color: string, corrupt = false, delta = false, width = 64, jpeg = false) => {
          const image = tile(delta ? 32 : width, color, delta ? 1 : 0, jpeg);
          w.rtcCallbacks.onFrame({sequence,width,height:32,keyframe:!delta&&!jpeg,
            tiles:[corrupt?{...image,data:jpeg?"/9j/": "invalid-frame"}:image]});
        };
        w.sendMixedCorruptDelta = () => w.rtcCallbacks.onFrame({sequence:14,width:64,height:32,keyframe:false,
          tiles:[tile(32,"#00ffff",0,true),{...tile(32,"#00ffff",1,true),data:"/9j/"}]});
        w.sendKeyframeBurst(10,"#ff0000");
      });
      await page.getByText("Store · 화면 수신 중",{exact:true}).waitFor();
      await page.evaluate(scenario => {
        const w = window as any;
        const NativeImage = window.Image;
        let created = 0;
        w.burstImageCount = () => created;
        w.Image = function() {
          const img = new NativeImage();
          if (++created === 1) Object.defineProperty(img,"onload",{set(callback) {
            img.addEventListener("load",() => {w.releaseBurstFrame = () => callback.call(img);},{once:true});
          }});
          return img;
        };
        const covered = scenario.includes("covered-delta");
        if (scenario === "newer-partial-delta") {
          w.sendKeyframeBurst(15,"#ffff00",false,true);
          w.sendKeyframeBurst(14,"#00ffff",false,false,64,true);
          return;
        }
        w.sendKeyframeBurst(11,"#00ff00",false,false,64,covered);
        if (scenario === "legacy-resize") {
          w.sendKeyframeBurst(undefined,"#ff00ff",false,false,96);
          w.sendKeyframeBurst(11,"#00ffff");
        } else if (scenario === "delta" || scenario === "resize") {
          w.sendKeyframeBurst(12,"#0000ff");
          w.sendKeyframeBurst(13,"#ff00ff",false,scenario === "delta",scenario === "resize" ? 96 : 64);
          w.sendKeyframeBurst(14,"#00ffff");
        } else {
          if (scenario === "corrupt" || scenario === "corrupt-covered-delta") w.sendKeyframeBurst(14,"#00ffff",true,false,64,covered);
          if (scenario === "mixed-corrupt-covered-delta") w.sendMixedCorruptDelta();
          w.sendKeyframeBurst(12,"#0000ff",false,false,64,covered);
          w.sendKeyframeBurst(13,"#ff00ff",false,false,64,covered);
          if (scenario === "same-size" || scenario === "covered-delta" || scenario === "covered-delta-background") w.sendKeyframeBurst(14,"#00ffff",false,false,64,covered);
        }
        if (scenario !== "legacy-resize" && scenario !== "mixed-corrupt-covered-delta") w.sendKeyframeBurst(15,"#ffff00",false,true);
      }, scenario);
      await page.waitForFunction(() => typeof (window as any).releaseBurstFrame === "function");
      expect(await page.evaluate(() => (window as any).burstImageCount())).toBe(scenario === "newer-partial-delta" ? 2 : 1);
      await page.evaluate(background => {
        if (background) {
          Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
          window.requestAnimationFrame = () => -1;
          document.dispatchEvent(new Event("visibilitychange"));
        }
        (window as any).releaseBurstFrame();
      }, scenario === "covered-delta-background");
      const canvas = page.locator(".remote-canvas");
      const pixels = () => canvas.evaluate((node, jpeg) => {
        const ctx = (node as HTMLCanvasElement).getContext("2d")!;
        return [0,63].map(x => Array.from(ctx.getImageData(x,0,1,1).data, value => jpeg && value < 4 ? 0 : jpeg && value > 251 ? 255 : value));
      }, scenario.includes("covered-delta") || scenario === "newer-partial-delta");
      await expect.poll(pixels).toEqual([scenario === "corrupt" || scenario === "corrupt-covered-delta" ? [255,0,255,255] : [0,255,255,255],
        scenario === "legacy-resize" ? [0,255,255,255] : scenario === "mixed-corrupt-covered-delta" ? [255,0,255,255] : [255,255,0,255]]);
      expect(await canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBe(64);
      expect(await page.evaluate(() => (window as any).burstImageCount())).toBe({"same-size":3,corrupt:4,delta:5,resize:5,"legacy-resize":3,
        "covered-delta":3,"corrupt-covered-delta":4,"mixed-corrupt-covered-delta":4,"covered-delta-background":3,"newer-partial-delta":2}[scenario]);
    } finally { await page.close(); }
  });

  it("keeps a dense 1080p delta visible without repeating unchanged picture and cursor state", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        const source = document.createElement("canvas");
        source.width = 1920; source.height = 1080;
        const ctx = source.getContext("2d")!;
        ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 1920, 1080);
        const frame = { width: 1920, height: 1080 };
        w.rtcCallbacks.onFrame({ ...frame, sequence: 1, keyframe: true,
          tiles: [{ x: 0, y: 0, w: 1920, h: 1080, data: source.toDataURL("image/jpeg").split(",")[1] }] });
        source.width = source.height = 32;
        const tiles = Array.from({ length: 100 }, (_, i) => {
          ctx.fillStyle = `rgb(${i}, 255, 0)`; ctx.fillRect(0, 0, 32, 32);
          return { x: i % 20, y: Math.floor(i / 20), w: 32, h: 32, data: source.toDataURL("image/png").split(",")[1] };
        });
        w.sendDenseDelta = () => {
          w.pictureStateDispatches = [];
          w.testPictureStateDispatch = (state: string) => w.pictureStateDispatches.push(state);
          w.rtcCallbacks.onFrame({ ...frame, sequence: 2, keyframe: false, cursorEmbedded: true, tiles });
        };
        w.sendCursorDelta = (sequence: number, cursorEmbedded: boolean, x: number) =>
          w.rtcCallbacks.onFrame({ ...frame, sequence, keyframe: false, cursorEmbedded, tiles: [{ ...tiles[0], x }] });
      });
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).sendDenseDelta());
      const canvas = page.locator(".remote-canvas");
      await expect.poll(() => canvas.evaluate(node => {
        const pixels = (node as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 640, 160).data;
        return Array.from({ length: 100 }, (_, i) => pixels[((Math.floor(i / 20) * 32 + 16) * 640 + i % 20 * 32 + 16) * 4 + 1])
          .filter(green => green === 255).length;
      })).toBe(100);
      await expect.poll(() => canvas.evaluate(node => getComputedStyle(node).cursor)).toBe("none");
      const paintedGreen = (x: number) => canvas.evaluate((node, x) =>
        (node as HTMLCanvasElement).getContext("2d")!.getImageData(x * 32 + 16, 16, 1, 1).data[1], x);
      await page.evaluate(() => (window as any).sendCursorDelta(4, true, 20));
      await expect.poll(() => paintedGreen(20)).toBe(255);
      await page.evaluate(() => (window as any).sendCursorDelta(3, false, 21));
      await expect.poll(() => paintedGreen(21)).toBe(255);
      expect(await canvas.evaluate(node => getComputedStyle(node).cursor)).toBe("none");
      const updates = await page.evaluate(() => (window as any).pictureStateDispatches as string[]);
      expect(updates).toEqual(["setRemoteCursorEmbedded"]);
    } finally { await page.close(); }
  });

  it("stops a missing visual ping, ignores its late marker and allows a clean retry", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        const source = document.createElement("canvas");
        source.width = source.height = 32;
        const ctx = source.getContext("2d")!;
        w.sendVisualPingFrame = (sequence: number, color: string) => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 32);
          w.rtcCallbacks.onFrame({ sequence, keyframe: sequence === 1, width: 32, height: 32,
            tiles: [{ x: 0, y: 0, w: 32, h: 32, data: source.toDataURL("image/jpeg").split(",")[1] }] });
        };
        w.sendVisualPingFrame(1, "#0050c0");
      });
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      const tools = page.getByTestId("secondary-tools");
      await tools.locator("summary").click();
      const count = () => page.evaluate(() => (window as any).testState.controls.filter((action: string) => action === "ping-color-change").length);
      expect(await count()).toBe(0);
      await tools.getByRole("button", { name: "Visual Ping", exact: true }).evaluate(button => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      expect(await count()).toBe(1);
      await tools.locator("summary").click();
      await tools.getByRole("button", { name: "측정 중", exact: true }).waitFor();
      await page.clock.runFor(5_100);
      await tools.getByRole("button", { name: "측정 시간 초과", exact: true }).waitFor();
      await page.evaluate(() => (window as any).sendVisualPingFrame(2, "#ff00ff"));
      await page.clock.runFor(100);
      await tools.getByRole("button", { name: "측정 시간 초과", exact: true }).waitFor();

      await page.evaluate(() => (window as any).sendVisualPingFrame(3, "#0050c0"));
      await page.clock.runFor(100);
      await tools.getByRole("button", { name: "측정 시간 초과", exact: true }).click();
      expect(await count()).toBe(2);
      await page.evaluate(() => (window as any).sendVisualPingFrame(4, "#ff00ff"));
      await page.clock.runFor(100);
      await tools.locator("summary").click();
      const result = tools.getByRole("button", { name: /E2E Latency:/ });
      await result.waitFor();
      await page.clock.runFor(5_100);
      await result.waitFor();
      expect(await count()).toBe(2);
    } finally { await page.close(); }
  });

  it("clears a running visual ping when the same Viewer panel refreshes its connection", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        w.previousPingTransport = w.rtcCallbacks;
        const source = document.createElement("canvas");
        source.width = source.height = 32;
        const ctx = source.getContext("2d")!;
        w.pingRefreshFrame = (sequence: number, color: string, previous = false) => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 32);
          (previous ? w.previousPingTransport : w.rtcCallbacks).onFrame({ sequence, keyframe: sequence === 1, width: 32, height: 32,
            tiles: [{ x: 0, y: 0, w: 32, h: 32, data: color === "invalid" ? "/invalid/" : source.toDataURL("image/jpeg").split(",")[1] }] });
        };
        w.pingRefreshFrame(1, "#0050c0");
      });
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      const tools = page.getByTestId("secondary-tools");
      await tools.locator("summary").click();
      await tools.getByRole("button", { name: "Visual Ping", exact: true }).click();
      await tools.locator("summary").click();
      await tools.getByRole("button", { name: "측정 중", exact: true }).waitFor();
      await page.evaluate(() => (window as any).pingRefreshFrame(2, "invalid"));
      await page.getByRole("button", { name: "원격 연결 새로고침", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts === 2);
      await page.evaluate(() => (window as any).pingRefreshFrame(1, "#0050c0"));
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      await page.clock.runFor(5_100);
      await tools.getByRole("button", { name: "Visual Ping", exact: true }).click();
      await page.evaluate(() => (window as any).pingRefreshFrame(3, "#ff00ff", true));
      await page.clock.runFor(100);
      await tools.locator("summary").click();
      await tools.getByRole("button", { name: "측정 중", exact: true }).waitFor();
      await page.evaluate(() => (window as any).pingRefreshFrame(2, "#ff00ff"));
      await page.clock.runFor(100);
      await tools.getByRole("button", { name: /E2E Latency:/ }).waitFor();
    } finally { await page.close(); }
  });

  it("skips decoding 1080p deltas already covered by the visible full picture", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        const source = document.createElement("canvas");
        const tile = (x: number, y: number, width: number, height: number, color: string) => {
          source.width = width; source.height = height;
          const ctx = source.getContext("2d")!;
          ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
          return { x, y, w: width, h: height, data: source.toDataURL("image/jpeg").split(",")[1] };
        };
        const frame = { width: 1920, height: 1080 };
        w.rtcCallbacks.onFrame({ ...frame, sequence: 5, keyframe: true, tiles: [tile(0, 0, 1920, 1080, "#0000ff")] });
        const obsolete = Array.from({ length: 64 }, (_, i) => tile(i % 16, Math.floor(i / 16), 32, 32, `rgb(255, ${i * 3}, 0)`));
        const yellow = tile(2, 0, 32, 32, "#ffff00");
        const green = tile(0, 0, 32, 32, "#00ff00");
        const red = tile(1, 0, 32, 32, "#ff0000");
        w.sendCoveredDeltas = () => {
          const NativeImage = window.Image;
          w.coveredDeltaImages = 0;
          w.Image = function() { w.coveredDeltaImages++; return new NativeImage(); };
          w.rtcCallbacks.onFrame({ ...frame, sequence: 4, keyframe: false, tiles: obsolete });
          return w.coveredDeltaImages;
        };
        w.sendRemainingDelta = (sequence: number) => {
          w.rtcCallbacks.onFrame({ ...frame, sequence, keyframe: false, tiles: [sequence === 5 ? yellow : sequence === 7 ? green : red] });
        };
      });
      await page.getByText("Store · 화면 수신 중", { exact: true }).waitFor();
      const images = await page.evaluate(() => (window as any).sendCoveredDeltas());
      expect(images).toBe(0);
      const pixels = () => page.locator(".remote-canvas").evaluate(node => {
        const ctx = (node as HTMLCanvasElement).getContext("2d")!;
        return [1, 33, 65].map(x => Array.from(ctx.getImageData(x, 1, 1, 1).data.slice(0, 3)).map(channel => channel > 240));
      });
      const blue = [false, false, true], yellow = [true, true, false], green = [false, true, false], red = [true, false, false];
      await expect.poll(pixels).toEqual([blue, blue, blue]);
      await page.evaluate(() => (window as any).sendRemainingDelta(5));
      await expect.poll(pixels).toEqual([blue, blue, yellow]);
      await page.evaluate(() => (window as any).sendRemainingDelta(7));
      await expect.poll(pixels).toEqual([green, blue, yellow]);
      await page.evaluate(() => (window as any).sendRemainingDelta(6));
      await expect.poll(pixels).toEqual([green, red, yellow]);
      expect(await page.evaluate(() => (window as any).coveredDeltaImages)).toBe(3);
    } finally { await page.close(); }
  });

  it("does not compare a numbered delta against a legacy picture without a sequence", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) })
        .getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        const source = document.createElement("canvas");
        const picture = (width: number, color: string) => {
          const height = 32;
          source.width = width; source.height = height;
          const ctx = source.getContext("2d")!;
          ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
          return { width, height, tiles: [{ x: 0, y: 0, w: width, h: height, data: source.toDataURL("image/jpeg").split(",")[1] }] };
        };
        const frame = picture(96, "#0000ff"), modern = picture(96, "#00ff00");
        w.rtcCallbacks.onFrame(picture(64, "#0000ff"));
        w.sendLegacyResize = () => w.rtcCallbacks.onFrame(frame);
        w.sendSequencedBaseline = () => w.rtcCallbacks.onFrame({ ...modern, keyframe: false, sequence: 1 });
        w.sendSequenceZero = () => {
          const NativeImage = window.Image;
          let imageCount = 0;
          w.Image = function() { imageCount++; return new NativeImage(); };
          try {
            w.rtcCallbacks.onFrame({ ...frame, keyframe: false, sequence: 0, tiles: [{ ...frame.tiles[0], data: "invalid" }] });
            return imageCount;
          } finally { w.Image = NativeImage; }
        };
      });
      const status = page.getByTestId("remote-connection-status");
      const canvas = page.locator(".remote-canvas");
      await status.getByText(/화면 수신 중/).waitFor();
      await page.evaluate(() => (window as any).sendLegacyResize());
      await expect.poll(() => canvas.evaluate(node => (node as HTMLCanvasElement).width)).toBe(96);
      expect(await page.evaluate(() => (window as any).sendSequenceZero())).toBe(1);
      await status.getByText(/화면 표시 오류/).waitFor();
      await page.evaluate(() => (window as any).sendSequencedBaseline());
      await status.getByText(/화면 수신 중/).waitFor();
      expect(await canvas.evaluate(node => (node as HTMLCanvasElement).getContext("2d")!.getImageData(1, 1, 1, 1).data[1])).toBeGreaterThan(240);
      expect(await page.evaluate(() => (window as any).sendSequenceZero())).toBe(0);
    } finally { await page.close(); }
  });

  it("shares partial delta images without holding ready pixels behind a slow tile", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const source=document.createElement("canvas");source.width=1920;source.height=1080;
        const ctx=source.getContext("2d")!;ctx.fillStyle="#ff0000";ctx.fillRect(0,0,1920,1080);
        (window as any).rtcCallbacks.onFrame({sequence:1,width:1920,height:1080,keyframe:true,
          tiles:[{x:0,y:0,w:1920,h:1080,data:source.toDataURL("image/jpeg").split(",")[1]}]});
      });
      await page.getByText("Store · 화면 수신 중",{exact:true}).waitFor();
      await page.evaluate(() => {
        const w=window as any;
        const tile=document.createElement("canvas");tile.width=tile.height=32;
        const ctx=tile.getContext("2d")!;
        const jpeg=(color:string)=>{ctx.fillStyle=color;ctx.fillRect(0,0,32,32);return tile.toDataURL("image/jpeg").split(",")[1];};
        const green=jpeg("#00ff00"),blue=jpeg("#0000ff");
        const NativeImage=window.Image;
        w.partialDeltaImages=0;
        w.Image=function() {
          const img=new NativeImage();
          if (++w.partialDeltaImages===1) Object.defineProperty(img,"onload",{set(callback) {
            img.addEventListener("load",()=>{ w.releasePartialDelta=()=>callback.call(img); },{once:true});
          }});
          return img;
        };
        w.rtcCallbacks.onFrame({sequence:2,width:1920,height:1080,keyframe:false,
          tiles:[blue,green,green,green].map((data,x)=>({x,y:0,w:32,h:32,data}))});
        w.sendOverlappingDelta = () => {
          const held: (()=>void)[] = w.overlapDeltaLoads=[];
          let next=0;
          w.Image=function() {
            const img=new NativeImage(), position=next++;
            Object.defineProperty(img,"onload",{set(callback) {
              img.addEventListener("load",()=>{held[position]=()=>callback.call(img);},{once:true});
            }});
            return img;
          };
          w.rtcCallbacks.onFrame({sequence:3,width:1920,height:1080,keyframe:false,
            tiles:[{x:0,data:green},{x:1,data:blue},{x:1,data:green}].map(tile=>({...tile,y:0,w:32,h:32}))});
        };
      });
      const pixels=()=>page.locator(".remote-canvas").evaluate(node=>{
        const ctx=(node as HTMLCanvasElement).getContext("2d")!;
        return [16,48,80,112,144].map(x=>Array.from(ctx.getImageData(x,16,1,1).data).findIndex((value,index)=>index<3&&value>240));
      });
      await expect.poll(pixels).toEqual([0,1,1,1,0]);
      expect(await page.evaluate(()=>(window as any).partialDeltaImages)).toBe(2);
      await page.waitForFunction(() => typeof (window as any).releasePartialDelta === "function");
      await page.evaluate(()=>(window as any).releasePartialDelta());
      await expect.poll(pixels).toEqual([2,1,1,1,0]);
      await page.evaluate(()=>(window as any).sendOverlappingDelta());
      await page.waitForFunction(()=> (window as any).overlapDeltaLoads.filter(Boolean).length === 3);
      await page.evaluate(()=>{const loads=(window as any).overlapDeltaLoads;loads[0]();loads[1]();});
      await expect.poll(pixels).toEqual([1,2,1,1,0]);
      await page.evaluate(()=>(window as any).overlapDeltaLoads[2]());
      await expect.poll(pixels).toEqual([1,1,1,1,0]);
    } finally { await page.close(); }
  });

  it("reuses identical images within a full tile frame without skipping any coordinates", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === "function");
      await page.evaluate(() => {
        const w = window as any;
        const source = document.createElement("canvas");
        source.width = source.height = 32;
        const ctx = source.getContext("2d")!;
        const images = ["#ff0000","#00ff00"].map(color => {
          ctx.fillStyle = color;
          ctx.fillRect(0,0,32,32);
          return source.toDataURL("image/jpeg").split(",")[1];
        });
        const NativeImage = window.Image;
        w.repeatTileImageCount = 0;
        w.Image = function() { w.repeatTileImageCount++; return new NativeImage(); };
        w.repeatTileFrame = (sequence: number) => {
          const tiles = Array.from({length:32},(_,i)=>({x:i%16,y:Math.floor(i/16),w:32,h:32,data:images[(i%2+sequence)%2]}));
          if (sequence === 3) {
            tiles[14].w = 64;
            tiles.splice(15,1);
          }
          w.rtcCallbacks.onFrame({sequence,width:512,height:64,keyframe:sequence===1,tiles});
        };
        w.repeatTileFrame(1);
      });
      const pixels = () => page.locator(".remote-canvas").evaluate(node => {
        const canvas = node as HTMLCanvasElement;
        if (canvas.width !== 512 || canvas.height !== 64) return [];
        const ctx = canvas.getContext("2d")!;
        return Array.from({length:32},(_,i)=>{
          const [r,g] = ctx.getImageData((i%16)*32+16,Math.floor(i/16)*32+16,1,1).data;
          return r>240&&g<16 ? 0 : g>240&&r<16 ? 1 : -1;
        });
      });
      await expect.poll(pixels).toEqual(Array.from({length:32},(_,i)=>(i+1)%2));
      expect(await page.evaluate(() => (window as any).repeatTileImageCount)).toBe(2);
      await page.evaluate(() => (window as any).repeatTileFrame(2));
      await expect.poll(pixels).toEqual(Array.from({length:32},(_,i)=>i%2));
      expect(await page.evaluate(() => (window as any).repeatTileImageCount)).toBe(4);
      await page.evaluate(() => (window as any).repeatTileFrame(3));
      await expect.poll(pixels).toEqual(Array.from({length:32},(_,i)=>i===14||i===15 ? i%2 : (i+1)%2));
      expect(await page.evaluate(() => (window as any).repeatTileImageCount)).toBe(6);
    } finally { await page.close(); }
  });

  it("does not let an older complete frame reset newer pixels or a monitor resize", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.waitForFunction(() => typeof (window as any).rtcCallbacks?.onFrame === 'function');
      const send = (sequence: number | undefined, width: number, color: string, tileWidth = width, x = 0, invalid = false) => page.evaluate(input => {
        const source = document.createElement('canvas'); source.width = input.tileWidth; source.height = 32;
        const ctx = source.getContext('2d')!; ctx.fillStyle = input.color; ctx.fillRect(0,0,input.tileWidth,32);
        (window as any).rtcCallbacks.onFrame({sequence:input.sequence,keyframe:input.tileWidth===input.width,
          cursorEmbedded:input.sequence===12 || input.sequence===16,width:input.width,height:32,
          tiles:[{x:input.x,y:0,w:input.tileWidth,h:32,data:input.invalid?'invalid':source.toDataURL('image/jpeg').split(',')[1]}]});
      },{sequence,width,color,tileWidth,x,invalid});
      const canvas = page.locator('.remote-canvas');
      const pixel = (x: number, c: number) => canvas.evaluate((node, point) =>
        (node as HTMLCanvasElement).getContext('2d')!.getImageData(point.x,0,1,1).data[point.c],{x,c});
      const width = () => canvas.evaluate(node => (node as HTMLCanvasElement).width);
      const pictureError = page.getByTestId('remote-connection-status').getByText(/화면 표시 오류/);
      const holdNextDecode = (key: string, event = 'load') => page.evaluate(({key,event}) => {
        const NativeImage = window.Image;
        (window as any).Image = function() {
          window.Image = NativeImage;
          const img = new NativeImage();
          Object.defineProperty(img,`on${event}`,{set(callback) {
            img.addEventListener(event,() => { (window as any)[key] = () => callback.call(img); },{once:true});
          }});
          return img;
        };
      },{key,event});
      await send(10,64,'#ff0000');
      await expect.poll(() => pixel(63,0)).toBeGreaterThan(240);
      await send(11,64,'#0000ff',32,1,true);
      await pictureError.waitFor();
      await holdNextDecode('completeLateError','error');
      await send(11,64,'#0000ff',32,1,true);
      await page.waitForFunction(() => Boolean((window as any).completeLateError));
      await send(12,64,'#0000ff',32,1);
      await expect.poll(() => pixel(63,2)).toBeGreaterThan(240);
      await send(11,64,'#00ff00');
      await expect.poll(() => pixel(0,1)).toBeGreaterThan(240);
      expect(await pixel(63,2)).toBeGreaterThan(240);
      expect(await canvas.evaluate(node => getComputedStyle(node).cursor)).toBe('none');
      await pictureError.waitFor({state:'hidden'});
      await page.evaluate(() => (window as any).completeLateError());
      expect(await pictureError.count()).toBe(0);

      await send(13,96,'#00ff00');
      await expect.poll(() => pixel(95,1)).toBeGreaterThan(240);
      await send(12,64,'#ff0000');
      await send(14,96,'#0000ff',32,2);
      await expect.poll(() => pixel(95,2)).toBeGreaterThan(240);
      expect(await width()).toBe(96);

      await holdNextDecode('completeNewerDelta');
      await send(16,96,'#ff0000',32);
      await page.waitForFunction(() => Boolean((window as any).completeNewerDelta));
      await holdNextDecode('completeOlderKeyframe');
      await send(15,64,'#ffffff');
      await page.waitForFunction(() => Boolean((window as any).completeOlderKeyframe));
      await send(12,64,'#ffffff');
      await send(17,96,'#00ffff',32,1);
      await page.evaluate(() => (window as any).completeNewerDelta());
      await expect.poll(() => pixel(0,0)).toBeGreaterThan(240);
      await page.evaluate(() => (window as any).completeOlderKeyframe());
      await expect.poll(() => pixel(32,2)).toBeGreaterThan(240);
      expect(await width()).toBe(96);
      expect(await pixel(0,1)).toBeLessThan(10);
      expect(await pixel(95,2)).toBeGreaterThan(240);

      await send(18,80,'#ff0000');
      await expect.poll(width).toBe(80);
      await send(20,80,'#0000ff',32);
      await expect.poll(() => pixel(0,2)).toBeGreaterThan(240);
      await send(21,80,'#ffffff',32,1,true);
      await pictureError.waitFor();
      await send(19,80,'#00ff00');
      await expect.poll(() => pixel(79,1)).toBeGreaterThan(240);
      expect(await pictureError.count()).toBe(1);
      await send(undefined,40,'#0000ff');
      await expect.poll(width).toBe(40);
      expect(await pixel(39,2)).toBeGreaterThan(240);
      await pictureError.waitFor({state:'hidden'});
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

  it("forwards regularly spaced fast desktop pointer samples without a trailing timer", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts > 0);
      await page.clock.pauseAt(new Date(Date.now()+1_000));
      const canvas = page.locator(".remote-canvas");
      const counts = [];
      for (let index=0; index<12; index++) {
        if (index) await page.clock.runFor(16);
        counts.push(await canvas.evaluate((element, index) => {
          const w = window as any;
          const bounds = element.getBoundingClientRect();
          element.dispatchEvent(new PointerEvent("pointermove",{
            pointerType:"mouse",pointerId:1,bubbles:true,
            clientX:bounds.left + bounds.width*(0.2+index/25),clientY:bounds.top+bounds.height/2,
          }));
          return w.testState.controls.filter((action:string)=>action.startsWith("move ")).length;
        },index));
      }
      expect(counts).toEqual(Array.from({length:12},(_,index)=>index+1));
    } finally { await page.close(); }
  });

  it("sends a new pointer position with current bounds when the previous timer is overdue", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator(".table-row").filter({has:page.getByText("PC-0",{exact:true})})
        .getByRole("button",{name:"접속",exact:true}).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts > 0);
      await page.clock.pauseAt(new Date(Date.now()+1_000));
      const canvas = page.locator(".remote-canvas");
      await canvas.evaluate(element => {
        const w = window as any;
        w.overduePointerRect = new DOMRect(20,20,100,100);
        element.getBoundingClientRect = () => w.overduePointerRect;
        w.emitOverduePointer = (point: number) => element.dispatchEvent(new PointerEvent("pointermove",{
          pointerType:"mouse",pointerId:1,bubbles:true,clientX:point,clientY:point,
        }));
        w.emitOverduePointer(30);
      });
      await page.clock.runFor(8);
      await page.evaluate(() => {
        const schedule = window.setTimeout;
        window.setTimeout = ((handler:TimerHandler, delay?:number, ...args:unknown[]) =>
          schedule(handler,(delay ?? 0)+120,...args)) as typeof setTimeout;
        try { (window as any).emitOverduePointer(60); }
        finally { window.setTimeout = schedule; }
      });
      const moves = () => page.evaluate(() => (window as any).testState.controls.filter((action:string)=>action.startsWith("move ")));
      expect(await moves()).toEqual(["move 6554 6554"]);
      await page.clock.runFor(20);
      await page.evaluate(() => {
        const w = window as any;
        w.overduePointerRect = new DOMRect(40,40,200,200);
        w.emitOverduePointer(140);
      });
      expect(await moves()).toEqual(["move 6554 6554","move 32768 32768"]);
      await page.clock.runFor(200);
      expect(await moves()).toEqual(["move 6554 6554","move 32768 32768"]);

      await page.evaluate(() => (window as any).emitOverduePointer(90));
      await page.clock.runFor(8);
      await canvas.evaluate(element => {
        const wall = Object.getOwnPropertyDescriptor(performance,"now");
        const beforeLayout = performance.now();
        const originalBounds = element.getBoundingClientRect;
        let spent = 0;
        Object.defineProperty(performance,"now",{configurable:true,value:()=>beforeLayout+spent});
        element.getBoundingClientRect = () => { spent = 10; return originalBounds(); };
        try { (window as any).emitOverduePointer(190); }
        finally {
          element.getBoundingClientRect = originalBounds;
          if (wall) Object.defineProperty(performance,"now",wall);
          else Reflect.deleteProperty(performance,"now");
        }
      });
      expect((await moves()).slice(-2)).toEqual(["move 16384 16384","move 49151 49151"]);
    } finally { await page.close(); }
  });

  it("samples one layout per pointer move burst and preserves release and wheel coordinates", async () => {
    const page = await openViewer({connected:true});
    try {
      await page.locator('.table-row').filter({has:page.getByText('PC-0',{exact:true})}).getByRole('button',{name:'접속',exact:true}).click();
      await page.getByTestId('remote-session-workspace').waitFor();
      await page.waitForFunction(() => (window as any).testState.rtcStarts > 0);
      await page.clock.pauseAt(new Date(Date.now()+1_000));
      await page.locator('.remote-canvas').evaluate(canvas => {
        const w=window as any;
        w.layoutReads=0;
        w.testState.controls=[];
        w.canvasForPointerFixture=canvas;
        w.pointerRect=new DOMRect(40,70,200,160);
        const nativeBounds=canvas.getBoundingClientRect.bind(canvas);
        canvas.getBoundingClientRect=()=>{w.layoutReads++;return (canvas as HTMLElement).style.display==='none'?nativeBounds():w.pointerRect;};
        canvas.setPointerCapture=()=>{};
        canvas.hasPointerCapture=()=>false;
        w.emitPointer=(type:string,clientX:number,clientY:number,buttons=0)=>canvas.dispatchEvent(new PointerEvent(type,{
          pointerType:'mouse',pointerId:1,button:0,buttons,clientX,clientY,bubbles:true,cancelable:true,
        }));
        w.emitWheel=()=>canvas.dispatchEvent(new WheelEvent('wheel',{clientX:240,clientY:150,deltaY:120,bubbles:true,cancelable:true}));
        w.emitPointer('pointermove',140,150);
        for(let i=0;i<200;i++) w.emitPointer('pointermove',40+(i%200),70+(i%160));
        w.emitPointer('pointermove',190,190);
      });
      const current=()=>page.evaluate(()=>{const w=window as any;return {layout:w.layoutReads,commands:w.testState.controls};});
      expect(await current()).toEqual({layout:2,commands:['move 32768 32768']});
      await page.clock.runFor(17);
      expect(await current()).toEqual({layout:3,commands:['move 32768 32768','move 49151 49151']});
      await page.evaluate(()=>{
        const w=window as any;w.testState.controls=[];
        w.emitPointer('pointerdown',40,70,1);
        w.emitPointer('pointermove',240,230,1);
        window.dispatchEvent(new FocusEvent('blur'));
      });
      expect((await current()).commands).toEqual(['mouse-down 0 0 left','mouse-up 65535 65535 left']);
      await page.evaluate(()=>{
        const w=window as any;w.testState.controls=[];
        w.emitPointer('pointermove',40,70);
        w.emitWheel();
      });
      await page.clock.runFor(20);
      expect((await current()).commands).toEqual(['mouse-wheel 65535 32768 -120']);
      await page.evaluate(()=>{
        const w=window as any;w.testState.controls=[];
        w.emitPointer('pointermove',140,150);
        w.emitPointer('pointermove',190,190);
        w.pointerRect=new DOMRect(40,70,400,320);
      });
      await page.clock.runFor(20);
      expect((await current()).commands).toEqual(['move 32768 32768']);
      await page.evaluate(()=>{
        const w=window as any;w.testState.controls=[];
        w.pointerRect=new DOMRect(40,70,200,160);
        w.emitPointer('pointermove',140,150);
        w.emitPointer('pointerdown',140,150,1);
        w.emitPointer('pointermove',240,230,1);
        w.canvasForPointerFixture.style.display='none';
        window.dispatchEvent(new FocusEvent('blur'));
      });
      expect((await current()).commands).toEqual(['move 32768 32768','mouse-down 32768 32768 left','mouse-up 32768 32768 left']);
    } finally {await page.close();}
  });
  it("moves the mobile touchpad pointer without rerendering the full session panel", async () => {
    const page = await openViewer({ connected: true, mobile: true });
    try {
      await page.locator(".table-row").filter({ hasText: "PC-0" }).getByRole("button", { name: "접속", exact: true }).click();
      const panel = page.locator(".session-panel:not(.session-panel-inactive)");
      await panel.getByRole("button", { name: "터치패드 모드", exact: true }).click();
      const pointer = panel.getByLabel("원격 포인터", { exact: true });
      await pointer.waitFor();
      await page.clock.runFor(100);
      const surface = panel.getByLabel("원격 터치패드", { exact: true });
      const sample = await surface.evaluate(async element => {
        const w = window as any;
        const point = document.querySelector<SVGElement>(".mobile-remote-pointer")!;
        const before = point.getBoundingClientRect().left;
        const startCommands = w.testState.controls.length;
        const startRenders = w.testSessionPanelRenders;
        const pointerEvent = (type: string, x: number) => element.dispatchEvent(new PointerEvent(type, {
          pointerId: 1, pointerType: "touch", clientX: x, clientY: 80, bubbles: true,
        }));
        (element as HTMLElement).setPointerCapture = () => {};
        (element as HTMLElement).hasPointerCapture = () => false;
        pointerEvent("pointerdown", 60);
        for (let i = 1; i <= 12; i++) {
          pointerEvent("pointermove", 60 + i * 3);
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        pointerEvent("pointerup", 96);
        return {
          panelRenders: w.testSessionPanelRenders - startRenders,
          shift: point.getBoundingClientRect().left - before,
          moves: w.testState.controls.slice(startCommands).filter((command: string) => command.startsWith("move ")) as string[],
        };
      });
      expect(sample.moves).toHaveLength(12);
      expect(sample.shift).toBeGreaterThan(35);
      expect(sample.shift).toBeLessThan(37);
      expect(sample.panelRenders).toBe(0);

      const movedX = (await pointer.boundingBox())!.x;
      await panel.getByRole("button", { name: "화면 및 세션 설정", exact: true }).click();
      await panel.getByRole("button", { name: "장비 목록", exact: true }).click();
      await page.getByText("열린 세션 1", { exact: true }).waitFor();
      await page.evaluate(() => {
        const w = window as any;
        w.temporarilyMissing = w.testState.devices.shift();
      });
      await refresh(page).click();
      await expect.poll(() => page.locator("canvas.remote-canvas").count()).toBe(0);
      await page.evaluate(() => {
        const w = window as any;
        w.testState.devices.unshift(w.temporarilyMissing);
      });
      await refresh(page).click();
      await page.getByRole("navigation", { name: "열린 세션 바로가기", exact: true })
        .getByRole("button", { name: "PC-0", exact: true }).click();
      await pointer.waitFor();
      await expect.poll(async () => Math.abs((await pointer.boundingBox())!.x - movedX)).toBeLessThan(1);
      await surface.evaluate(element => {
        (element as HTMLElement).setPointerCapture = () => {};
        (element as HTMLElement).hasPointerCapture = () => false;
        for (const type of ["pointerdown", "pointerup"]) {
          element.dispatchEvent(new PointerEvent(type, {
            pointerId: 1, pointerType: "touch", clientX: 60, clientY: 80, bubbles: true,
          }));
        }
      });
      const coordinates = sample.moves[sample.moves.length - 1].slice("move ".length);
      await expect.poll(() => page.evaluate(() => (window as any).testState.controls.filter((action: string) =>
        action.startsWith("mouse-down ") || action.startsWith("mouse-up ")).slice(-2)))
        .toEqual([`mouse-down ${coordinates} left`, `mouse-up ${coordinates} left`]);
    } finally {
      await page.close();
    }
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
