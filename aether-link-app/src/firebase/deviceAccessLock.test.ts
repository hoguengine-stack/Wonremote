import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDeviceAccessLock } from "../agent/deviceAccessLock";
import { requestFirebaseDeviceAccess, openFirebaseSession } from "./viewerFirebase";
import { isAgentDeviceAccessSessionAllowed, processAgentDeviceAccessRequest } from "./agentFirebase";
import { getDocFromServer } from "firebase/firestore";

const state = vi.hoisted(() => ({
  viewerUid:'viewer-1',
  documents:new Map<string, any>(), listeners:new Map<string, (snapshot: any) => void>(),
  reads:0, writes:0, listenCount:0, closeCount:0, beforeCommit:undefined as (()=>Promise<void>) | undefined,
  commands:[] as string[], unsubscribed:0,
  transactionRead:undefined as ((path:string, attempt:number)=>Promise<void>) | undefined, transactionAttempts:1,
}));
const snapshot = (ref: {path:string}) => ({id:ref.path.split('/').pop(), exists:()=>state.documents.has(ref.path), data:()=>state.documents.get(ref.path)});
function store(ref: {path:string}, data: any, merge = false) {
  state.writes++;
  const next = {...(merge ? state.documents.get(ref.path) : {}), ...data};
  for (const key of Object.keys(next)) if (next[key]?.__serverTime) next[key] = {toMillis:()=>Date.now()};
  state.documents.set(ref.path, next);
  const listener = state.listeners.get(ref.path);
  if (listener) { state.reads++; queueMicrotask(()=>listener(snapshot(ref))); }
  if (typeof next.action === 'string') state.commands.push(next.action);
}
vi.mock("./firebaseConfig", () => ({resolveFirebaseConfig:()=>({apiKey:"test",appId:"test",authDomain:"test",projectId:"test"})}));
vi.mock("./firebaseServices", () => ({getWonRemoteFirebaseServices:()=>({auth:{get currentUser(){return {uid:state.viewerUid};}},db:{}})}));
vi.mock("firebase/firestore", async original => ({
  ...await original<typeof import("firebase/firestore")>(),
  doc: vi.fn((db: any, ...parts: string[]) => ({path:[db?.path, ...parts.filter(Boolean)].filter(Boolean).join('/')})),
  collection:vi.fn((_db: any, ...parts: string[])=>({path:parts.join('/')})),
  getDocFromServer:vi.fn(async ref=>{state.reads++; return snapshot(ref);}),
  serverTimestamp:()=>({__serverTime:true}),
  onSnapshot:vi.fn((ref, next) => {
    state.listenCount++; state.reads++; state.listeners.set(ref.path,next); queueMicrotask(()=>next(snapshot(ref)));
    return ()=>{state.listeners.delete(ref.path);state.unsubscribed++;};
  }),
  writeBatch:()=>{
    const changes:Array<()=>void> = [];
    return {set:(ref:any,data:any)=>changes.push(()=>store(ref,data)), commit:async ()=>{changes.forEach(change=>change()); await state.beforeCommit?.();}};
  },
  runTransaction:async (_db:any, execute:any)=>{
    for(let attempt=0;attempt<state.transactionAttempts;attempt++){
      const changes:Array<()=>void> = [];
      const result = await execute({get:async(ref:any)=>{state.reads++;await state.transactionRead?.(ref.path,attempt);return snapshot(ref);},
        set:(ref:any,data:any)=>changes.push(()=>store(ref,data)),update:(ref:any,data:any)=>changes.push(()=>store(ref,data,true))});
      if(attempt===state.transactionAttempts-1){changes.forEach(change=>change());return result;}
    }
  },
  updateDoc:async(ref:any,data:any)=>store(ref,data,true),
  deleteDoc:async(ref:any)=>{if(state.documents.get(ref.path)?.state!=='pending') throw Error('Cannot delete completed grant');state.writes++;state.documents.delete(ref.path);},
}));

beforeEach(()=>{state.viewerUid='viewer-1';state.documents.clear();state.listeners.clear();state.reads=0;state.writes=0;state.listenCount=0;state.unsubscribed=0;state.commands=[];state.closeCount=0;state.beforeCommit=undefined;state.transactionRead=undefined;state.transactionAttempts=1;});
afterEach(()=>vi.useRealTimers());

describe("Viewer-to-Agent encrypted device access request",()=>{
  function pendingApproval(operation='connect') {
    const id='12345678-1234-4234-8234-123456789012',requestPath=`deviceAccessRequests/${id}`,lockPath='deviceAccessLocks/device-1';
    state.documents.set(requestPath,{id,deviceId:'device-1',ownerUid:'viewer-1',operation,sessionId:'s1',lockVersion:'v1',state:'pending',createdAt:{toMillis:()=>Date.now()}});
    state.documents.set(lockPath,{enabled:true,version:'v1'});
    const publicState={enabled:true,version:'v1',publicKey:'synthetic'};
    const lock={publicState,authorize:vi.fn(async(_request, _now, publish)=>{await publish(publicState);return publicState;}),signApproval:vi.fn(()=> 'synthetic-signature')} as unknown as AgentDeviceAccessLock;
    return {id,requestPath,lockPath,lock};
  }
  it('starts both approval transaction reads before either resolves and writes only after both',async()=>{
    const {id,requestPath,lockPath,lock}=pendingApproval();
    const started:string[]=[];
    let releaseRequest!:()=>void,releaseLock!:()=>void;
    const requestGate=new Promise<void>(resolve=>{releaseRequest=resolve;}),lockGate=new Promise<void>(resolve=>{releaseLock=resolve;});
    state.transactionRead=async name=>{started.push(name);await(name===requestPath?requestGate:lockGate);};
    const pending=processAgentDeviceAccessRequest('device-1',id,lock,vi.fn());
    try {
      await vi.waitFor(()=>expect(started).toEqual([requestPath,lockPath]),{timeout:200});
      expect(state.writes).toBe(0);expect(lock.signApproval).not.toHaveBeenCalled();
      releaseLock();await Promise.resolve();expect(state.writes).toBe(0);
      releaseRequest();await pending;
      expect(state.documents.get(requestPath).state).toBe('approved');expect(state.reads).toBe(4);expect(state.writes).toBe(1);
    } finally {releaseRequest();releaseLock();await pending;}
  });
  it.each(['request','lock'])("never approves after the %s transaction read fails while the other read completes late",async failing=>{
    const {id,requestPath,lockPath,lock}=pendingApproval();
    let release!:()=>void;
    const late=new Promise<void>(resolve=>{release=resolve;});
    const started:string[]=[];
    state.transactionRead=async name=>{
      started.push(name);
      if(name===(failing==='request'?requestPath:lockPath)) throw new Error('permission-denied');
      await late;
    };
    try {
      await processAgentDeviceAccessRequest('device-1',id,lock,vi.fn());
      expect(started).toEqual([requestPath,lockPath]);expect(state.reads).toBe(4);
      expect(state.documents.get(requestPath)).toMatchObject({state:'denied',error:'permission-denied'});
      expect(lock.signApproval).not.toHaveBeenCalled();expect(state.writes).toBe(1);
      release();await Promise.resolve();await Promise.resolve();
      expect(state.documents.get(requestPath).state).toBe('denied');expect(state.writes).toBe(1);
    } finally {release();}
  });
  it('denies a lock version rotated while approval transaction reads are pending',async()=>{
    const {id,requestPath,lockPath,lock}=pendingApproval();
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const started:string[]=[];
    state.transactionRead=async name=>{started.push(name);await gate;};
    const pending=processAgentDeviceAccessRequest('device-1',id,lock,vi.fn());
    try {
      await vi.waitFor(()=>expect(started).toEqual([requestPath,lockPath]));
      state.documents.set(lockPath,{enabled:true,version:'v2'});release();await pending;
      expect(state.documents.get(requestPath).state).toBe('denied');expect(lock.signApproval).not.toHaveBeenCalled();
      expect(state.documents.get(lockPath).version).toBe('v2');
    } finally {release();await pending;}
  });
  it('does not repeat authorization or session-stop side effects when the approval callback retries',async()=>{
    const {id,requestPath,lock}=pendingApproval('disable');
    const stop=vi.fn();state.transactionAttempts=2;
    const attempts:number[]=[];
    state.transactionRead=async(_name,attempt)=>{attempts.push(attempt);};
    await processAgentDeviceAccessRequest('device-1',id,lock,stop);
    expect(attempts).toEqual([0,0,1,1]);expect(state.reads).toBe(6);
    expect(lock.authorize).toHaveBeenCalledOnce();expect(stop).toHaveBeenCalledOnce();
    expect(lock.signApproval).toHaveBeenCalledTimes(2);expect(state.writes).toBe(3);
    expect(state.documents.get(requestPath).state).toBe('approved');
  });
  it('keeps completed and invalid requests out of lock lookup and transaction work',async()=>{
    const {id,requestPath,lock}=pendingApproval();
    state.documents.set(requestPath,{...state.documents.get(requestPath),state:'approved'});
    state.transactionRead=vi.fn();
    await processAgentDeviceAccessRequest('device-1',id,lock,vi.fn());
    expect(state.reads).toBe(1);expect(state.writes).toBe(0);expect(state.transactionRead).not.toHaveBeenCalled();
    expect(lock.authorize).not.toHaveBeenCalled();
    await expect(processAgentDeviceAccessRequest('device-1','invalid',lock,vi.fn())).rejects.toThrow('잘못된');
    expect(state.reads).toBe(1);
  });
  it.each(['standalone','session'])("does not transfer a pending %s request to a changed login account",async mode=>{
    state.documents.set('devices/device-1',{status:'online',protocolVersion:2,accessLocked:true,accessPublicKey:'not-used',accessLockVersion:'v1'});
    vi.mocked(getDocFromServer).mockImplementationOnce(async ref=>{state.reads++;state.viewerUid='viewer-2';return snapshot(ref as any) as any;});
    const pending=mode==='standalone'?requestFirebaseDeviceAccess('device-1','disable',{password:'test-password'}):openFirebaseSession('device-1',undefined,false,'test-password');
    await expect(pending).rejects.toThrow('로그인 계정이 변경');
    expect(state.reads).toBe(1);expect(state.writes).toBe(0);expect(state.listenCount).toBe(0);expect(state.commands).toEqual([]);
  });
  it.each(['offline','missing-key','unavailable'])("rejects %s from the single fresh open snapshot before creating any command",async scenario=>{
    state.documents.set('devices/device-1',{status:scenario==='offline'?'offline':'online',protocolVersion:2,
      accessLocked:true,accessLockUnavailable:scenario==='unavailable'});
    await expect(openFirebaseSession('device-1',undefined,false,'test-password')).rejects.toThrow(
      scenario==='offline'?'online':scenario==='unavailable'?'잠금 저장소':'업데이트');
    expect(state.reads).toBe(1);expect(state.writes).toBe(0);
    expect(state.commands).toEqual([]);expect(state.listenCount).toBe(0);
  });
  it.each(['encryption','approval'])("stops a changed account after asynchronous %s without starting a session",async stage=>{
    const keys=generateKeyPairSync('rsa',{modulusLength:2048});
    state.documents.set('devices/device-1',{status:'online',protocolVersion:2,accessLocked:true,accessLockVersion:'v1',
      accessPublicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')});
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
    const spy=stage==='encryption'?vi.spyOn(crypto.subtle,'encrypt').mockImplementation(async(...args)=>{
      const result=await encrypt(...args);state.viewerUid='viewer-2';return result;
    }):undefined;
    if(stage==='approval') state.beforeCommit=async()=>{
      const request=[...state.documents.entries()].find(([key])=>key.startsWith('deviceAccessRequests/'))!;
      store({path:request[0]},{...request[1],state:'approved',approvedVersion:'v1'});
      state.viewerUid='viewer-2';
    };
    try {
      await expect(openFirebaseSession('device-1',undefined,false,'test-password')).rejects.toThrow('로그인 계정이 변경');
      expect(state.commands.some(command=>command.startsWith('start-stream '))).toBe(false);
      expect([...state.documents.keys()].some(key=>key.startsWith('sessions/'))).toBe(false);
      expect(state.listeners.size).toBe(0);
      if(stage==='encryption') expect(state.writes).toBe(0);
    } finally {spy?.mockRestore();}
  });
  it.each([false,true])("preserves unavailable local lock storage only when the fresh server lock is disabled (enabled=%s)",async enabled=>{
    state.documents.set("deviceAccessLocks/device-1",{enabled,version:"v1"});
    expect(await isAgentDeviceAccessSessionAllowed("device-1","s1",null)).toBe(!enabled);
    expect(state.reads).toBe(1);expect(state.writes).toBe(0);
  });
  it("overlaps fresh lock/session reads, keeps grant verification and uses three reads per locked start", async () => {
    const lock = {publicState:{enabled:true,version:"v1"},verifyApproval:vi.fn(()=>true)} as unknown as AgentDeviceAccessLock;
    state.documents.set("deviceAccessLocks/device-1",{enabled:true,version:"v1"});
    state.documents.set("sessions/s1",{deviceId:"device-1",state:"connected",accessLockVersion:"v1",accessRequestId:"r1",ownerUid:"viewer-1"});
    state.documents.set("deviceAccessRequests/r1",{state:"approved",operation:"connect",sessionId:"s1",deviceId:"device-1",ownerUid:"viewer-1",approvedVersion:"v1",approvalSignature:"signature"});
    let release!:()=>void;
    const blocked = new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(getDocFromServer).mockImplementationOnce(async ref=>{state.reads++;await blocked;return snapshot(ref as any) as any;});
    const pending=isAgentDeviceAccessSessionAllowed("device-1","s1",lock);
    expect(state.reads).toBe(2);
    expect(lock.verifyApproval).not.toHaveBeenCalled();
    release();
    expect(await pending).toBe(true);
    expect(state.reads).toBe(3);
    expect(lock.verifyApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({sessionId:"s1"}),"v1","signature");
    expect(await Promise.all([isAgentDeviceAccessSessionAllowed("device-1","s1",lock),isAgentDeviceAccessSessionAllowed("device-1","s1",lock)])).toEqual([true,true]);
    expect(state.reads).toBe(9);
    const counts={reads:state.reads,writes:state.writes,listeners:state.listenCount};
    vi.useFakeTimers();await vi.advanceTimersByTimeAsync(86_400_000);
    expect({reads:state.reads,writes:state.writes,listeners:state.listenCount}).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["unlocked","local-mismatch","version","device","closed","request-owner","signature","read-error"])("preserves denial and bounded reads for %s", async scenario => {
    const lock={publicState:{enabled:scenario!=="unlocked",version:"v1"},verifyApproval:vi.fn(()=>scenario!=="signature")} as unknown as AgentDeviceAccessLock;
    state.documents.set("deviceAccessLocks/device-1",{enabled:scenario!=="unlocked"&&scenario!=="local-mismatch",version:scenario==="version"?"v2":"v1"});
    state.documents.set("sessions/s1",{deviceId:scenario==="device"?"other":"device-1",state:scenario==="closed"?"closed":"connected",accessLockVersion:"v1",accessRequestId:"r1",ownerUid:"viewer-1"});
    state.documents.set("deviceAccessRequests/r1",{state:"approved",operation:"connect",sessionId:"s1",deviceId:"device-1",ownerUid:scenario==="request-owner"?"other":"viewer-1",approvedVersion:"v1",approvalSignature:"signature"});
    if(scenario==="read-error") vi.mocked(getDocFromServer).mockRejectedValueOnce(new Error("permission-denied"));
    if(scenario==="read-error") await expect(isAgentDeviceAccessSessionAllowed("device-1","s1",lock)).rejects.toThrow("permission-denied");
    else expect(await isAgentDeviceAccessSessionAllowed("device-1","s1",lock)).toBe(scenario==="unlocked");
    expect(state.reads).toBeLessThanOrEqual(3);
    if(scenario==="unlocked") expect(state.reads).toBe(1);
    expect(state.writes).toBe(0);expect(state.listenCount).toBe(0);
  });
  it.each(['cancel','timeout'])("cleans up %s without retry or late completion",async(reason)=>{
    const keys=generateKeyPairSync('rsa',{modulusLength:2048});
    state.documents.set('devices/device-1',{accessPublicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')});
    vi.useFakeTimers();
    const controller=new AbortController();
    const pending=requestFirebaseDeviceAccess('device-1','set',{password:'',newPassword:'password'},'',controller.signal);
    const rejected=expect(pending).rejects.toThrow(reason==='cancel'?'취소':'응답하지');
    await vi.waitFor(()=>expect(state.listeners.size).toBe(1));
    if(reason==='cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(state.listeners.size).toBe(0);expect(state.unsubscribed).toBe(1);
    expect([...state.documents.keys()].filter(key=>key.startsWith('deviceAccessRequests/'))).toEqual([]);
    expect(state.commands).toHaveLength(1);
    const counts={reads:state.reads,writes:state.writes,listeners:state.listenCount};
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect({reads:state.reads,writes:state.writes,listeners:state.listenCount}).toEqual(counts);
  });
  it.runIf(process.platform === 'win32')("executes real crypto/storage and binds approved sessions without plaintext cloud data or idle requests",async()=>{
    const directory=await mkdtemp(path.join(os.tmpdir(),'wonremote-access-roundtrip-'));
    try {
      const lock=await AgentDeviceAccessLock.load(path.join(directory,'lock.dat'),'device-1');
      state.documents.set('devices/device-1',{id:'device-1',accessPublicKey:lock.publicState.publicKey,status:'online',protocolVersion:2});
      state.beforeCommit=async()=>{
        const command=state.commands[state.commands.length-1];
        if(command?.startsWith('device-access ')) await processAgentDeviceAccessRequest('device-1',command.slice(14),lock,async()=>{state.closeCount++;});
      };
      const started=await requestFirebaseDeviceAccess('device-1','set',{password:'',newPassword:'test-password'});
      expect({reads:state.reads,writes:state.writes,listeners:state.listenCount}).toEqual({reads:6,writes:5,listeners:1});
      expect(state.documents.get('deviceAccessLocks/device-1')).toMatchObject({enabled:true,version:started.version});
      expect(state.closeCount).toBe(1);
      expect(state.listeners.size).toBe(0);
      await expect(requestFirebaseDeviceAccess('device-1','connect',{password:'wrong'},'bad-session')).rejects.toThrow('일치하지');
      expect([...state.documents.keys()].filter(key=>key.startsWith('sessions/'))).toEqual([]);
      const readsBeforeStart=state.reads, writesBeforeStart=state.writes;
      vi.mocked(getDocFromServer).mockClear();
      const result=await openFirebaseSession('device-1',undefined,false,'test-password');
      expect(vi.mocked(getDocFromServer).mock.calls.filter(([ref])=>(ref as any).path==='devices/device-1')).toHaveLength(1);
      expect({reads:state.reads-readsBeforeStart,writes:state.writes-writesBeforeStart}).toEqual({reads:6,writes:5});
      const session=state.documents.get(`sessions/${result.session.id}`);
      expect(session.accessLockVersion).toBe(started.version);
      expect(session.accessRequestId).toBeTypeOf('string');
      expect(await isAgentDeviceAccessSessionAllowed('device-1',result.session.id,lock)).toBe(true);
      const grant = state.documents.get(`deviceAccessRequests/${session.accessRequestId}`);
      const signature = grant.approvalSignature;
      grant.approvalSignature = 'A'.repeat(344);
      expect(await isAgentDeviceAccessSessionAllowed('device-1',result.session.id,lock)).toBe(false);
      grant.approvalSignature = signature;
      state.documents.set(`sessions/${result.session.id}-replay`,{...session,id:`${result.session.id}-replay`});
      expect(await isAgentDeviceAccessSessionAllowed('device-1',`${result.session.id}-replay`,lock)).toBe(false);
      const serialized=JSON.stringify([...state.documents.entries()]);
      expect(serialized).not.toContain('test-password');
      expect(serialized).not.toContain('PRIVATE KEY');
      const processed=[...state.documents.values()].find(value=>value.operation==='connect'&&value.state==='approved');
      const before={reads:state.reads,writes:state.writes,closes:state.closeCount};
      await processAgentDeviceAccessRequest('device-1',processed.id,lock,async()=>{state.closeCount++;});
      expect(state.writes).toBe(before.writes);expect(state.closeCount).toBe(before.closes);
      const processRequest=state.beforeCommit;
      const previousLock=state.documents.get('deviceAccessLocks/device-1');
      const previousDevice=state.documents.get('devices/device-1');
      const sessionsBeforeRotation=[...state.documents.keys()].filter(key=>key.startsWith('sessions/'));
      state.beforeCommit=async()=>{
        state.documents.set('deviceAccessLocks/device-1',{...previousLock,version:'rotated-after-read'});
        state.documents.set('devices/device-1',{...previousDevice,accessLockVersion:'rotated-after-read'});
        await processRequest?.();
      };
      vi.mocked(getDocFromServer).mockClear();
      await expect(openFirebaseSession('device-1',undefined,false,'test-password')).rejects.toThrow('잠금 설정이 변경');
      expect(vi.mocked(getDocFromServer).mock.calls.filter(([ref])=>(ref as any).path==='devices/device-1')).toHaveLength(1);
      expect([...state.documents.keys()].filter(key=>key.startsWith('sessions/'))).toEqual(sessionsBeforeRotation);
      state.documents.set('deviceAccessLocks/device-1',previousLock);
      state.documents.set('devices/device-1',previousDevice);
      state.beforeCommit=processRequest;
      vi.mocked(getDocFromServer).mockClear();
      await requestFirebaseDeviceAccess('device-1','disable',{password:'test-password'});
      expect(vi.mocked(getDocFromServer).mock.calls.filter(([ref])=>(ref as any).path==='devices/device-1')).toHaveLength(1);
      expect(state.documents.get('deviceAccessLocks/device-1').enabled).toBe(false);
      const counts={reads:state.reads,writes:state.writes,listeners:state.listenCount};
      vi.useFakeTimers();await vi.advanceTimersByTimeAsync(86_400_000);
      expect({reads:state.reads,writes:state.writes,listeners:state.listenCount}).toEqual(counts);
      expect(state.listeners.size).toBe(0);expect(state.unsubscribed).toBe(state.listenCount);
    } finally {
      const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('wonremote-access-roundtrip-')) throw Error('Unexpected owned test path');
      await rm(resolved,{recursive:true,force:true});
    }
  },90_000);
});
