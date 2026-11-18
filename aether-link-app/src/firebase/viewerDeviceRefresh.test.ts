import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDoc, getDoc, getDocFromServer, getDocs, getDocsFromServer, onSnapshot, writeBatch } from "firebase/firestore";
import { fetchFirebaseDevices, openFirebaseSession, requestFirebaseSecureSession,subscribeFirebaseAgentUpdate } from "./viewerFirebase";

const state = vi.hoisted(() => ({ set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./firebaseConfig", () => ({ resolveFirebaseConfig: () => ({ projectId: "test" }) }));
vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: () => ({ db: {}, auth: { currentUser: { uid: "viewer-1" } } }),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...parts: string[]) => parts.join("/")),
  doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join("/") || "commands/new", id: "new" })),
  documentId: () => "__name__",
  getDoc: vi.fn(), getDocFromServer: vi.fn(), getDocs: vi.fn(), getDocsFromServer: vi.fn(), onSnapshot: vi.fn(),
  query: vi.fn((path: unknown, filter: unknown) => ({ path, filter })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  addDoc: vi.fn().mockResolvedValue({ id: "command" }),
  serverTimestamp: vi.fn(() => "server-time"), setDoc: vi.fn().mockResolvedValue(undefined),
  writeBatch: vi.fn(() => ({ set: state.set, commit: state.commit })),
}));
const device = (overrides = {}) => ({
  businessNumber: "123-45-67890", deviceNumber: "AGENT-TEST0001", desktopName: "PC", deviceName: "POS",
  storeName: "Store", status: "online", lastSeenAt: new Date().toISOString(), protocolVersion: 2, ...overrides,
});
const env: ImportMetaEnv = { ...import.meta.env, VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE: "direct" };

describe("fresh device reads without collection listeners", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("observes only the explicitly updated device, skips cached success and exposes deletion/error with owned cleanup",async()=>{
    let reply!:(snapshot:any)=>void,fail!:(error:Error)=>void;const stop=vi.fn(),next=vi.fn(),error=vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((ref:any,n:any,f:any)=>{expect(ref.path).toBe("devices/target");reply=n;fail=f;return stop;}) as any);
    const unsubscribe=subscribeFirebaseAgentUpdate("target",next,error);
    reply({id:"target",metadata:{fromCache:true},exists:()=>true,data:()=>device({updateState:"healthy"})});expect(next).not.toHaveBeenCalled();
    reply({id:"target",metadata:{fromCache:false},exists:()=>true,data:()=>device({updateRequestId:"1700000000001",updateState:"downloading",updateProgress:35})});
    expect(next).toHaveBeenCalledWith(expect.objectContaining({id:"target",updateRequestId:"1700000000001",updateProgress:35}));
    reply({id:"target",exists:()=>false});expect(error).toHaveBeenCalledOnce();fail(new Error("permission-denied"));expect(error).toHaveBeenCalledTimes(2);
    unsubscribe();await vi.advanceTimersByTimeAsync(86_400_000);expect(stop).toHaveBeenCalledOnce();expect(onSnapshot).toHaveBeenCalledOnce();expect(getDocsFromServer).not.toHaveBeenCalled();expect(addDoc).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });

  it("watches only the selected manual devices being probed and ignores unconfirmed replies", async () => {
    const manual = device({presenceMode:"manual"}), periodic = device({presenceMode:"periodic"});
    const known = [{id:"target",...manual},{id:"second",...manual},{id:"periodic",...periodic},
      {id:"periodic-2",...periodic},{id:"outside",...manual}] as any;
    const ids = ["target","target","second","periodic","periodic-2"];
    vi.mocked(getDocFromServer).mockImplementation(async (ref:any) => ({
      id:ref.path.split("/").at(-1),exists:()=>true,data:()=>manual,
    } as any));
    vi.mocked(getDocsFromServer).mockResolvedValueOnce({
      docs:["periodic","periodic-2"].map(id => ({id,exists:()=>true,data:()=>periodic})),
    } as any);
    const replies = new Map<string,(value:any) => void>();
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((ref:{path:string},_options:unknown,next:(value:any)=>void) => {
      replies.set(ref.path,next); return stop;
    }) as any);
    const progress = vi.fn();
    const result = fetchFirebaseDevices(env,true,undefined,progress,known,ids);
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(getDocFromServer).mock.calls.map(([ref])=>ref.path)).toEqual(["devices/target","devices/second"]);
    expect(getDocsFromServer).toHaveBeenCalledExactlyOnceWith({
      path:"devices",filter:{field:"__name__",op:"in",value:["periodic","periodic-2"]},
    });
    expect(vi.mocked(addDoc).mock.calls.map(([ref])=>ref)).toEqual(["devices/target/commands","devices/second/commands"]);
    const nonce = (vi.mocked(addDoc).mock.calls[0][1] as any).action.split(" ")[1];
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect([...replies.keys()]).toEqual(["devices/target","devices/second"]);
    expect(vi.mocked(onSnapshot).mock.calls.map(call=>call[1])).toEqual(Array(2).fill({includeMetadataChanges:true}));
    const heartbeat = (id:string, fromCache=false, hasPendingWrites=false, requestId=nonce) => ({
      id,exists:()=>true,metadata:{fromCache,hasPendingWrites},data:()=>({...manual,heartbeatRequestId:requestId}),
    });
    replies.get("devices/target")!(heartbeat("target",true));
    replies.get("devices/target")!(heartbeat("target",false,true));
    replies.get("devices/second")!(heartbeat("second",false,false,"stale-nonce"));
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.mock.lastCall?.[1]).toEqual(["target","second"]);
    replies.get("devices/target")!(heartbeat("target"));
    replies.get("devices/second")!(heartbeat("second"));
    expect((await result).map(row=>row.id)).toEqual(["periodic","periodic-2","second","target"]);
    expect(stop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(getDocFromServer).toHaveBeenCalledTimes(2);
    expect(addDoc).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads 61 unique selected IDs in bounded queries without restoring deleted or absent rows", async () => {
    const ids = Array.from({length:61},(_,i)=>`selected-${i}`);
    vi.mocked(getDocFromServer).mockResolvedValue({exists:()=>false,data:()=>undefined} as any);
    vi.mocked(getDocsFromServer).mockImplementation(async (ref:any) => ({
      docs:ref.filter.value.filter((id:string)=>id!==ids[30]).map((id:string) => ({
        id, exists:()=>true, data:()=>device({presenceMode:"periodic",...(id===ids[60]?{deletedAt:"deleted"}:{})}),
      })),
    } as any));
    const progress = vi.fn();
    const rows = await fetchFirebaseDevices(env,true,undefined,progress,[],[...ids,ids[0]]);
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(vi.mocked(getDocsFromServer).mock.calls).toEqual([0,30,60].map(start => [{
      path:"devices",filter:{field:"__name__",op:"in",value:ids.slice(start,start+30)},
    }]));
    expect(rows.map(row=>row.id).sort()).toEqual(ids.filter((_,i)=>i!==30&&i!==60).sort());
    expect(progress).toHaveBeenLastCalledWith(rows,[]);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledTimes(3);
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("closes the manual watch and ignores other chunks when a grouped query is denied", async () => {
    const manual = device({presenceMode:"manual"}), progress = vi.fn(), stop = vi.fn();
    const selectedIds = ["manual", ...Array.from({length:31},(_,index)=>`periodic-${index}`)];
    let reply!: (snapshot: any) => void;
    vi.mocked(getDocFromServer).mockResolvedValueOnce({id:"manual",exists:()=>true,data:()=>manual} as any);
    vi.mocked(onSnapshot).mockReturnValueOnce(stop);
    vi.mocked(getDocsFromServer).mockRejectedValueOnce(new Error("permission-denied"))
      .mockReturnValueOnce(new Promise(resolve => { reply=resolve; }));
    const refresh = fetchFirebaseDevices(env,true,undefined,progress,[{id:"manual",...manual}] as any,selectedIds);
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledOnce();
    const updates = progress.mock.calls.length;
    await expect(refresh).rejects.toThrow("permission-denied");
    expect(stop).toHaveBeenCalledOnce();
    reply({docs:[{id:"periodic-30",exists:()=>true,data:()=>manual}]});
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(progress).toHaveBeenCalledTimes(updates);
    expect(getDocsFromServer).toHaveBeenCalledTimes(2);
    expect(getDocFromServer).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a newly manual row from a late grouped response after cancellation", async () => {
    let reply!: (snapshot: any) => void;
    vi.mocked(getDocsFromServer).mockReturnValueOnce(new Promise(resolve => { reply=resolve; }));
    const abort = new AbortController(), progress = vi.fn();
    const result = expect(fetchFirebaseDevices(env,true,abort.signal,progress,[],["first","second"]))
      .rejects.toThrow("cancelled");
    const updates = progress.mock.calls.length;
    abort.abort();
    await result;
    reply({docs:[{id:"first",exists:()=>true,data:()=>device({presenceMode:"manual"})}]});
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledTimes(updates);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fetches selected periodic rows without any presence listener or commands", async () => {
    const record = device({presenceMode:"periodic"});
    const known = [{id:"periodic",...record},{id:"outside",...device({presenceMode:"manual"})}] as any;
    vi.mocked(getDocFromServer).mockResolvedValue({id:"periodic",exists:()=>true,data:()=>record} as any);
    const progress = vi.fn();
    await expect(fetchFirebaseDevices(env,true,undefined,progress,known,["periodic"]))
      .resolves.toMatchObject([{id:"periodic",status:"online"}]);
    expect(getDocFromServer).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(expect.any(Array),[]);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false,true])("only probes a newly manual selected device after the fresh read (cancelled=%s)", async cancelled => {
    const known = [{id:"target",...device({presenceMode:"periodic"})}] as any;
    const manual = device({presenceMode:"manual"});
    let finishRead!: (snapshot: any) => void;
    vi.mocked(getDocFromServer).mockReturnValueOnce(new Promise(resolve => { finishRead=resolve; }));
    const stop=vi.fn();
    if (!cancelled) vi.mocked(onSnapshot).mockReturnValueOnce(stop);
    const abort=new AbortController(), progress=vi.fn();
    const result=fetchFirebaseDevices(env,true,abort.signal,progress,known,["target"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
    const progressCount = progress.mock.calls.length;
    if (cancelled) {
      const rejected = expect(result).rejects.toThrow("cancelled");
      abort.abort();
      await rejected;
    }
    finishRead({id:"target",exists:()=>true,data:()=>manual});
    await vi.advanceTimersByTimeAsync(0);
    if (cancelled) {
      expect(progress).toHaveBeenCalledTimes(progressCount);
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(addDoc).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } else {
      expect(progress.mock.lastCall?.[1]).toEqual(["target"]);
      expect(onSnapshot).toHaveBeenCalledOnce();
      expect(addDoc).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject([{id:"target",status:"offline",presenceCheckTimedOut:true}]);
      expect(stop).toHaveBeenCalledOnce();
    }
    expect(getDocFromServer).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("scoped empty results cost no reads; timeout, permission failure and abort clear only target listeners",async()=>{
    expect(await fetchFirebaseDevices(env,true,undefined,undefined,[],[])).toEqual([]);expect(getDocFromServer).not.toHaveBeenCalled();expect(onSnapshot).not.toHaveBeenCalled();
    const record=device({presenceMode:"manual"}),known=[{id:"target",...record}] as any,stops=[vi.fn(),vi.fn(),vi.fn()];
    vi.mocked(getDocFromServer).mockResolvedValue({id:"target",exists:()=>true,data:()=>record} as any);
    vi.mocked(onSnapshot).mockReturnValueOnce(stops[0]).mockReturnValueOnce(stops[1]).mockReturnValueOnce(stops[2]);
    const timed=fetchFirebaseDevices(env,true,undefined,undefined,known,["target"]);await vi.advanceTimersByTimeAsync(5_000);expect((await timed)[0].status).toBe("offline");
    vi.mocked(getDocFromServer).mockRejectedValueOnce(new Error("Permission denied"));
    await expect(fetchFirebaseDevices(env,true,undefined,undefined,known,["target"])).rejects.toThrow("Permission denied");
    const abort=new AbortController(),cancelled=fetchFirebaseDevices(env,true,abort.signal,undefined,known,["target"]);
    const rejected=expect(cancelled).rejects.toThrow("cancelled");abort.abort();await rejected;
    for(const stop of stops)expect(stop).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(86_400_000);expect(vi.getTimerCount()).toBe(0);
  });

  it("performs exactly 11 server list reads for login plus 10 refreshes, none on idle", async () => {
    vi.mocked(getDocsFromServer).mockResolvedValue({ docs: Array.from({ length: 10 }, (_, i) => ({
      id: `device-${i}`, data: () => device({ deviceNumber: `AGENT-${i}`, desktopName: `PC-${i}` }),
    })) } as any);
    for (let i = 0; i < 11; i++) expect(await fetchFirebaseDevices(env)).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledTimes(11);
    expect(getDocs).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("reads only the selected target once per connection, retaining protocol and offline rejection", async () => {
    vi.mocked(getDocFromServer).mockResolvedValue({ id: "device-1", exists: () => true, data: () => device() } as any);
    for (let i = 0; i < 10; i++) await openFirebaseSession("device-1", env);
    expect(getDocFromServer).toHaveBeenCalledTimes(10);
    expect(state.set).toHaveBeenCalledTimes(20);
    expect(getDoc).not.toHaveBeenCalled();
    expect(getDocsFromServer).not.toHaveBeenCalled();
    expect(getDocs).not.toHaveBeenCalled();
  });

  it.each([true, false])("requests manual presence once and accepts confirmed metadata (cache resync: %s)", async cacheResync => {
    const record = device({ presenceMode: "manual", lastSeenAt: "2020-01-01T00:00:00Z" });
    vi.mocked(getDocsFromServer).mockResolvedValue({ docs: [{ id: "device-1", data: () => record }] } as any);
    let next!: (snapshot: any) => void;
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((_query: unknown, _options: unknown, callback: typeof next) => { next = callback; return stop; }) as any);
    const progress = vi.fn();
    const result = fetchFirebaseDevices(env, true, undefined, progress);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledWith(expect.any(Array), ["device-1"]);
    expect(addDoc).toHaveBeenCalledOnce();
    const requestId = (vi.mocked(addDoc).mock.calls[0][1] as any).action.split(" ")[1];
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(
      {path:"devices",filter:{field:"heartbeatRequestId",op:"==",value:requestId}},
      {includeMetadataChanges:true}, expect.any(Function), expect.any(Function),
    );
    const heartbeat = {id:"device-1",metadata:{hasPendingWrites:false},data:()=>({...record,heartbeatRequestId:requestId})};
    const snapshot = (fromCache:boolean, docs:unknown[]) => ({metadata:{fromCache},docs,docChanges:()=>[]});
    next(snapshot(true,[heartbeat]));
    expect(stop).not.toHaveBeenCalled();
    next(snapshot(false,[{...heartbeat,metadata:{hasPendingWrites:true}}]));
    expect(stop).not.toHaveBeenCalled();
    if (cacheResync) {
      // On resync the same document can become server-backed with no data changes.
      next(snapshot(true,[heartbeat]));
      next(snapshot(false,[heartbeat]));
    } else {
      const changes = vi.fn(() => [{type:"modified",doc:heartbeat}]);
      next({...snapshot(false,[heartbeat]),docChanges:changes});
      expect(changes).toHaveBeenCalledWith({includeMetadataChanges:true});
    }
    expect(progress.mock.lastCall?.[1]).toEqual([]);
    expect((await result)[0]).toMatchObject({ status: "online", presenceMode: "manual" });
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledOnce(); expect(addDoc).toHaveBeenCalledOnce();
  });

  it("checks known devices before the list read finishes and checks only new IDs afterward", async () => {
    const record = device({ presenceMode: "manual" });
    let finishRead!: (value: any) => void;
    vi.mocked(getDocsFromServer).mockReturnValue(new Promise(resolve => { finishRead = resolve; }) as any);
    let next!: (snapshot: any) => void;
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((_query: unknown, _options: unknown, callback: typeof next) => { next = callback; return stop; }) as any);
    const progress = vi.fn();
    const known = { id: "device-1", ...record } as any;
    const result = fetchFirebaseDevices(env, true, undefined, progress, [known]);
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
    const requestId = (vi.mocked(addDoc).mock.calls[0][1] as any).action.split(" ")[1];
    const unrelated = vi.fn(() => ({...record,heartbeatRequestId:"different-attempt"}));
    next({metadata:{fromCache:false},docs:[]});
    next({metadata:{fromCache:false},docChanges:() => [
      {type:"removed",doc:{id:"previous",data:unrelated}},
      {type:"added",doc:{id:known.id,metadata:{hasPendingWrites:false},data:()=>({...record,heartbeatRequestId:requestId})}},
    ]});
    await vi.advanceTimersByTimeAsync(0);
    expect(unrelated).not.toHaveBeenCalled();
    expect(progress.mock.lastCall?.[1]).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    finishRead({ docs: [
      { id: known.id, data: () => ({ ...record, desktopName: "Renamed" }) },
      { id: "new", data: () => ({ ...record, desktopName: "New PC" }) },
    ] });
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledTimes(2);
    expect(progress.mock.lastCall?.[0][0]).toMatchObject({ desktopName: "Renamed", status: "online" });
    expect(progress.mock.lastCall?.[1]).toEqual(["new"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).map(d => [d.id, d.status])).toEqual([[known.id, "online"], ["new", "offline"]]);
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels parallel checks without dispatching devices from a late list read", async () => {
    const record = device({ presenceMode: "manual" });
    let finishRead!: (value: any) => void;
    vi.mocked(getDocsFromServer).mockReturnValue(new Promise(resolve => { finishRead = resolve; }) as any);
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockReturnValue(stop);
    const abort = new AbortController();
    const result = fetchFirebaseDevices(env, true, abort.signal, undefined, [{ id: "old", ...record } as any]);
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(addDoc).toHaveBeenCalledOnce();
    abort.abort();
    await rejected;
    finishRead({ docs: [{ id: "new", data: () => record }] });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(stop).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on a denied reply query without re-reading, retrying or probing late devices", async () => {
    const record = device({presenceMode:"manual"});
    let resolveList!: (value:unknown) => void;
    vi.mocked(getDocsFromServer).mockReturnValueOnce(new Promise(resolve => { resolveList = resolve; }) as any);
    let fail!: (error:Error) => void;
    const stop = vi.fn();
    vi.mocked(onSnapshot).mockImplementation(((_query:unknown, _options:unknown, _next:unknown, error:typeof fail) => {
      fail = error;
      return stop;
    }) as any);
    const refresh = fetchFirebaseDevices(env,true,undefined,undefined,[{id:"existing",...record}] as any);
    const rejection = expect(refresh).rejects.toThrow("Permission denied");
    fail(new Error("Permission denied"));
    await rejection;
    resolveList({docs:[{id:"late",data:()=>record}]});
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(stop).toHaveBeenCalledOnce();
    expect(addDoc).toHaveBeenCalledOnce();
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([openFirebaseSession, requestFirebaseSecureSession])("rejects unavailable or incompatible targets before issuing commands", async (connect) => {
    for (const data of [device({ status: "offline" }), device({ protocolVersion: 999 })]) {
      vi.mocked(getDocFromServer).mockResolvedValue({ id: "device-1", exists: () => true, data: () => data } as any);
      await expect(connect("device-1", env)).rejects.toThrow();
    }
    vi.mocked(getDocFromServer).mockRejectedValueOnce(new Error("Quota exceeded."));
    await expect(connect("device-1", env)).rejects.toThrow("Quota exceeded.");
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocFromServer).toHaveBeenCalledTimes(3);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(getDoc).not.toHaveBeenCalled();
  });
});
