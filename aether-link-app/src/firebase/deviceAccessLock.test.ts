import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDeviceAccessLock } from "../agent/deviceAccessLock";
import { requestFirebaseDeviceAccess, openFirebaseSession } from "./viewerFirebase";
import { isAgentDeviceAccessSessionAllowed, processAgentDeviceAccessRequest } from "./agentFirebase";

const state = vi.hoisted(() => ({
  documents:new Map<string, any>(), listeners:new Map<string, (snapshot: any) => void>(),
  reads:0, writes:0, listenCount:0, closeCount:0, beforeCommit:undefined as (()=>Promise<void>) | undefined,
  commands:[] as string[], unsubscribed:0,
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
vi.mock("./firebaseServices", () => ({getWonRemoteFirebaseServices:()=>({auth:{currentUser:{uid:"viewer-1"}},db:{}})}));
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
    const changes:Array<()=>void> = [];
    const result = await execute({get:async(ref:any)=>{state.reads++;return snapshot(ref);},
      set:(ref:any,data:any)=>changes.push(()=>store(ref,data)),update:(ref:any,data:any)=>changes.push(()=>store(ref,data,true))});
    changes.forEach(change=>change());return result;
  },
  updateDoc:async(ref:any,data:any)=>store(ref,data,true),
  deleteDoc:async(ref:any)=>{if(state.documents.get(ref.path)?.state!=='pending') throw Error('Cannot delete completed grant');state.writes++;state.documents.delete(ref.path);},
}));

beforeEach(()=>{state.documents.clear();state.listeners.clear();state.reads=0;state.writes=0;state.listenCount=0;state.unsubscribed=0;state.commands=[];state.closeCount=0;state.beforeCommit=undefined;});
afterEach(()=>vi.useRealTimers());

describe("Viewer-to-Agent encrypted device access request",()=>{
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
      const result=await openFirebaseSession('device-1',undefined,false,'test-password');
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
      await requestFirebaseDeviceAccess('device-1','disable',{password:'test-password'});
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
