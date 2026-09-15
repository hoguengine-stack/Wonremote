import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createFileChannelSender } from "../agent/fileChannelSender";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { processWebRtcFileChunk } from "../agent/webrtcFileReceiver";
import { parseWebRtcControlAction } from "../domain/webrtcControl";
import { WEBRTC_FILE_CHUNK_BYTES, parseWebRtcFileChunk, parseWebRtcFileAck, serializeWebRtcFileAck, serializeWebRtcFileChunk } from "../domain/webrtcFileTransfer";

const firestoreMocks = vi.hoisted(() => ({
  limit: vi.fn((count: number) => ({ kind: "limit", count })),
  onSnapshot: vi.fn((
    _target: { path?: string },
    _next?: (snapshot: {
      data?: () => Record<string, unknown> | undefined;
      docs?: Array<{ id: string; data: () => Record<string, unknown> }>;
    }) => void,
    _error?: (error: Error) => void,
  ) => () => undefined),
  orderBy: vi.fn((field: string, direction: string) => ({ kind: "orderBy", field, direction })),
  query: vi.fn((target: { path?: string }, ...constraints: unknown[]) => ({ ...target, constraints })),
  safeAddDoc: vi.fn(async () => ({ id: "candidate-1" })),
  safeSetDoc: vi.fn(async () => undefined),
}));

function reverseEmptyChunk() {
  return serializeWebRtcFileChunk({ type: "file-chunk", transferId: "incoming", filename: "empty.txt", chunkIndex: 0,
    totalChunks: 1, totalBytes: 0, isLast: true, fileData: "", chunkSha256: "a".repeat(64) });
}

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ kind: "collection", path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ kind: "doc", path: segments.join("/") })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: firestoreMocks.limit,
  onSnapshot: firestoreMocks.onSnapshot,
  orderBy: firestoreMocks.orderBy,
  query: firestoreMocks.query,
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => ({ auth: { currentUser: { uid: "owner-1" } }, db: {}, functions: {}, storage: {} })),
}));

vi.mock("./firestoreWrite", () => ({
  safeAddDoc: firestoreMocks.safeAddDoc,
  safeBatchSet: vi.fn(),
  safeBatchUpdate: vi.fn(),
  safeSetDoc: firestoreMocks.safeSetDoc,
  safeUpdateDoc: vi.fn(),
}));

class FakeDataChannel {
  bufferedAmount = 0;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = "connecting";
  send = vi.fn();

  constructor(public readonly label: string, public readonly options: RTCDataChannelInit) {}

  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection;
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  readonly channels = new Map<string, FakeDataChannel>();

  constructor() {
    FakePeerConnection.latest = this;
  }

  close = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer" as RTCSdpType, sdp: "viewer-offer" }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async (_description?: RTCSessionDescriptionInit): Promise<void> => undefined);
  addIceCandidate = vi.fn(async (_candidate?: RTCIceCandidateInit): Promise<void> => undefined);

  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new FakeDataChannel(label, options);
    this.channels.set(label, channel);
    return channel;
  }
}

describe("Viewer WebRTC transport", () => {
  it("accepts capability only from the active open file channel with the supported protocol", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onReverseFileSupport = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport("capabilities", { onFrame: vi.fn(), onReverseFileSupport }, {} as ImportMetaEnv);
    const channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    const handler = channel.onmessage!;
    const payload = JSON.stringify({ type: "file-capabilities", reverseFileSend: 1 });
    handler({ data: payload });
    expect(onReverseFileSupport).not.toHaveBeenCalled();
    channel.readyState = "open"; channel.onopen?.();
    handler({ data: JSON.stringify({ type: "file-capabilities", reverseFileSend: true }) });
    expect(onReverseFileSupport).not.toHaveBeenCalled();
    handler({ data: payload });
    expect(onReverseFileSupport).toHaveBeenCalledOnce();
    expect(onReverseFileSupport).toHaveBeenLastCalledWith(false);
    handler({ data: JSON.stringify({ type: "file-capabilities", reverseFileSend: 1, reverseFileResume: true }) });
    expect(onReverseFileSupport).toHaveBeenLastCalledWith(false);
    handler({ data: JSON.stringify({ type: "file-capabilities", reverseFileSend: 1, reverseFileResume: 1 }) });
    expect(onReverseFileSupport).toHaveBeenLastCalledWith(true);
    transport.close(); handler({ data: payload });
    expect(onReverseFileSupport).toHaveBeenCalledTimes(3);
  });
  it("routes file status only on the active channel and drops invalid or late messages", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onFileStatus = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport("file-status", { onFrame: vi.fn(), onFileStatus }, {} as ImportMetaEnv);
    const channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    const status = { type: "file-status", requestId: "reverse", state: "selecting" };
    const handler = channel.onmessage!;
    handler({ data: JSON.stringify(status) });
    expect(onFileStatus).not.toHaveBeenCalled();
    channel.readyState = "open"; channel.onopen?.();
    handler({ data: JSON.stringify(status) });
    expect(onFileStatus).toHaveBeenCalledExactlyOnceWith(status);
    handler({ data: JSON.stringify({ ...status, state: "arbitrary" }) });
    transport.close();
    handler({ data: JSON.stringify(status) });
    expect(onFileStatus).toHaveBeenCalledOnce();
  });
  it("receives an Agent disk stream and acknowledges only after the storage handler completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wonremote-viewer-reverse-"));
    const sourcePath = path.join(root, "report.bin");
    const bytes = Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 9 + 4, 53);
    await writeFile(sourcePath, bytes);
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const destination = path.join(root, "received");
    const transport = await startFirebaseViewerWebRtcTransport("reverse", { onFrame: vi.fn(),
      onFileChunk: (chunk, isCurrent) => processWebRtcFileChunk(chunk, { isCurrent, env: { WONREMOTE_AGENT_DOWNLOADS_DIR: destination } }),
    }, {} as ImportMetaEnv);
    const channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    channel.readyState = "open"; channel.onopen?.();
    const sender = createFileChannelSender({ readyState: "open", send: payload => channel.onmessage?.({ data: payload }) });
    channel.send.mockImplementation(payload => sender.acknowledge(parseWebRtcFileAck(payload)!));
    try {
      await sender.sendFile({ sourcePath, transferId: "reverse-file" });
      expect(await readFile(path.join(destination, "report.bin"))).toEqual(bytes);
      expect(channel.send).toHaveBeenCalledTimes(10);
      const calls = channel.send.mock.calls;
      expect(parseWebRtcFileAck(calls[calls.length - 1][0])).toMatchObject({ status: "complete", receivedBytes: bytes.length });
    } finally { sender.close(); transport.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("does not acknowledge a pending save or a save finishing after session close", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const completeAck = { type: "file-ack" as const, transferId: "incoming", status: "complete" as const, receivedBytes: 0, receivedChunks: 1 };
    let finish!: (value: typeof completeAck) => void;
    let isCurrent!: () => boolean;
    const save = vi.fn((_chunk, current: () => boolean) => { isCurrent = current; return new Promise<typeof completeAck>(resolve => { finish = resolve; }); });
    const transport = await startFirebaseViewerWebRtcTransport("reverse-stale", { onFrame: vi.fn(), onFileChunk: save }, {} as ImportMetaEnv);
    const channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    channel.readyState = "open"; channel.onopen?.();
    const payload = reverseEmptyChunk();
    channel.onmessage?.({ data: payload });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(channel.send).not.toHaveBeenCalled();
    expect(isCurrent()).toBe(true);
    transport.close();
    expect(isCurrent()).toBe(false);
    finish(completeAck);
    await Promise.resolve(); await Promise.resolve();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("rejects unsupported receiving and bounds queued inbound chunks", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const unsupported = await startFirebaseViewerWebRtcTransport("reverse-unsupported", { onFrame: vi.fn() }, {} as ImportMetaEnv);
    let channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    channel.readyState = "open"; channel.onopen?.();
    channel.onmessage?.({ data: reverseEmptyChunk() });
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledOnce());
    expect(parseWebRtcFileAck(channel.send.mock.calls[0][0])).toMatchObject({ status: "error" });
    unsupported.close();
    const save = vi.fn(async () => null);
    const transport = await startFirebaseViewerWebRtcTransport("reverse-overflow", { onFrame: vi.fn(), onFileChunk: save }, {} as ImportMetaEnv);
    channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    channel.readyState = "open"; channel.onopen?.();
    try {
      for (let i = 0; i < 17; i++) channel.onmessage?.({ data: reverseEmptyChunk() });
      expect(channel.readyState).toBe("closed");
      await Promise.resolve(); await Promise.resolve();
      expect(save).not.toHaveBeenCalled();
    } finally { transport.close(); }
  });
  it("cancels an ACK wait immediately and removes its timer/listener before another transfer", async () => {
    vi.useFakeTimers();
    const {startFirebaseViewerWebRtcTransport}=await import('./viewerFirebase');
    const transport=await startFirebaseViewerWebRtcTransport('cancel-session',{onFrame:vi.fn()},{} as ImportMetaEnv);
    const channel=FakePeerConnection.latest.channels.get('wonremote-files')!;
    channel.readyState='open';channel.onopen?.();
    const abort=new AbortController();
    const add=vi.spyOn(abort.signal,'addEventListener'), remove=vi.spyOn(abort.signal,'removeEventListener');
    try {
      const pending=transport.sendFile({file:new Blob(['abc']),filename:'a.txt',fileSha256:'a'.repeat(64),transferId:'cancel',signal:abort.signal});
      const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
      await vi.waitFor(()=>expect(add).toHaveBeenCalledWith('abort',expect.any(Function),{once:true}));
      const timerCount=vi.getTimerCount();
      abort.abort();
      await rejected;
      expect(remove).toHaveBeenCalledWith('abort',add.mock.calls[0][1]);
      expect(vi.getTimerCount()).toBe(timerCount-1);
      channel.onmessage?.({data:serializeWebRtcFileAck({type:'file-ack',transferId:'cancel',receivedBytes:3,receivedChunks:1,status:'complete'})});
      const next=transport.sendFile({file:new Blob(['abc']),filename:'a.txt',fileSha256:'a'.repeat(64),transferId:'next'});
      await vi.waitFor(()=>expect(channel.send).toHaveBeenCalledTimes(2));
      channel.onmessage?.({data:serializeWebRtcFileAck({type:'file-ack',transferId:'next',receivedBytes:3,receivedChunks:1,status:'complete'})});
      await expect(next).resolves.toBe(true);
    } finally {transport.close();}
  });

  it("does not send a chunk if cancelled during file reading", async () => {
    const {startFirebaseViewerWebRtcTransport}=await import('./viewerFirebase');
    const transport=await startFirebaseViewerWebRtcTransport('cancel-read',{onFrame:vi.fn()},{} as ImportMetaEnv);
    const channel=FakePeerConnection.latest.channels.get('wonremote-files')!;
    channel.readyState='open';channel.onopen?.();
    const abort=new AbortController();
    const file=new Blob(['abc']);
    let finish!: (value:ArrayBuffer)=>void;
    vi.spyOn(file,'slice').mockReturnValue({arrayBuffer:()=>new Promise<ArrayBuffer>(resolve=>{finish=resolve;})} as Blob);
    try {
      const pending=transport.sendFile({file,filename:'a',fileSha256:'a'.repeat(64),transferId:'reading',signal:abort.signal});
      abort.abort();finish(new Uint8Array([1,2,3]).buffer);
      await expect(pending).rejects.toMatchObject({name:'AbortError'});
      expect(channel.send).not.toHaveBeenCalled();
    } finally {transport.close();}
  });
  it("resumes persisted Agent chunks and verifies the final file without resending the prefix", async () => {
    const root=await mkdtemp(path.join(tmpdir(),'wonremote-resume-'));
    const env={WONREMOTE_AGENT_DOWNLOADS_DIR:root};
    const bytes=Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES*4-10,37);
    const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
    for(let i=0;i<2;i++) {
      const chunk=bytes.subarray(i*WEBRTC_FILE_CHUNK_BYTES,(i+1)*WEBRTC_FILE_CHUNK_BYTES);
      await processWebRtcFileChunk({type:'file-chunk',transferId:'resume-1',filename:'resume.bin',chunkIndex:i,totalChunks:4,totalBytes:bytes.length,isLast:false,fileData:chunk.toString('base64'),chunkSha256:sha(chunk)},{env});
    }
    const {startFirebaseViewerWebRtcTransport}=await import('./viewerFirebase');
    const transport=await startFirebaseViewerWebRtcTransport('resume-session',{onFrame:vi.fn()},{} as ImportMetaEnv);
    const channel=FakePeerConnection.latest.channels.get('wonremote-files')!;
    channel.readyState='open';channel.onopen?.();
    let processing=Promise.resolve();
    channel.send.mockImplementation((payload:string)=>{
      processing=processing.then(async()=>{
        const ack=await processWebRtcFileChunk(parseWebRtcFileChunk(payload)!,{env});
        channel.onmessage?.({data:serializeWebRtcFileAck(ack!)});
      });
    });
    try {
      await expect(transport.sendFile({file:new Blob([bytes]),filename:'resume.bin',fileSha256:sha(bytes),transferId:'resume-1',resume:true})).resolves.toBe(true);
      expect(channel.send.mock.calls.map(([payload])=>parseWebRtcFileChunk(payload)?.chunkIndex)).toEqual([0,2,3]);
      expect(await readFile(path.join(root,'resume.bin'))).toEqual(bytes);
    } finally {transport.close();await processing;}
  });

  it("rejects resume offsets outside the source file", async () => {
    const {startFirebaseViewerWebRtcTransport}=await import('./viewerFirebase');
    const transport=await startFirebaseViewerWebRtcTransport('bad-resume',{onFrame:vi.fn()},{} as ImportMetaEnv);
    const channel=FakePeerConnection.latest.channels.get('wonremote-files')!;
    channel.readyState='open';channel.onopen?.();
    channel.send.mockImplementation(()=>channel.onmessage?.({data:serializeWebRtcFileAck({type:'file-ack',transferId:'bad',receivedChunks:99,receivedBytes:99*WEBRTC_FILE_CHUNK_BYTES,status:'duplicate'})}));
    try {
      await expect(transport.sendFile({file:new Blob([new Uint8Array(WEBRTC_FILE_CHUNK_BYTES+1)]),filename:'file.bin',fileSha256:'a'.repeat(64),transferId:'bad',resume:true})).rejects.toThrow('Invalid file resume');
    } finally {transport.close();}
  });
  it.each([
    { receivedBytes: 2, receivedChunks: 1 },
    { receivedBytes: 4, receivedChunks: 1 },
    { receivedBytes: 3, receivedChunks: 2 },
  ])("rejects mismatched completed ACK totals %j", async (totals) => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const transport = await startFirebaseViewerWebRtcTransport("invalid-final", { onFrame: vi.fn() }, {} as ImportMetaEnv);
    const channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    channel.readyState = "open";
    channel.onopen?.();
    channel.send.mockImplementation(() => channel.onmessage?.({ data: serializeWebRtcFileAck({
      type: "file-ack", transferId: "invalid-final", status: "complete", ...totals,
    }) }));
    const onProgress = vi.fn();
    try {
      await expect(transport.sendFile({ file: new Blob([new Uint8Array(3)]), filename: "file.bin",
        fileSha256: "a".repeat(64), transferId: "invalid-final", onProgress,
      })).rejects.toThrow("Invalid file completion acknowledgement");
      expect(onProgress).not.toHaveBeenCalled();
    } finally { transport.close(); }
  });

  it.each([false, true])("validates resumed completion totals (complete=%s)", async (complete) => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const transport = await startFirebaseViewerWebRtcTransport("resume-complete", { onFrame: vi.fn() }, {} as ImportMetaEnv);
    const channel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    channel.readyState = "open";
    channel.onopen?.();
    const size = WEBRTC_FILE_CHUNK_BYTES + 1;
    channel.send.mockImplementation(() => channel.onmessage?.({ data: serializeWebRtcFileAck({
      type: "file-ack", transferId: "resume-complete", status: "complete",
      receivedBytes: complete ? size : WEBRTC_FILE_CHUNK_BYTES, receivedChunks: complete ? 2 : 1,
    }) }));
    const onProgress = vi.fn();
    try {
      const result = transport.sendFile({ file: new Blob([new Uint8Array(size)]), filename: "file.bin",
        fileSha256: "a".repeat(64), transferId: "resume-complete", resume: true, onProgress });
      if (complete) {
        await expect(result).resolves.toBe(true);
        expect(onProgress).toHaveBeenCalledWith(size, size);
      } else {
        await expect(result).rejects.toThrow("Invalid file completion acknowledgement");
        expect(onProgress).not.toHaveBeenCalled();
      }
      expect(channel.send).toHaveBeenCalledOnce();
    } finally { transport.close(); }
  });

  beforeEach(() => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.clearAllMocks();
    firestoreMocks.safeAddDoc.mockResolvedValue({ id: "candidate-1" });
    firestoreMocks.safeSetDoc.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses separate unordered tile and ordered control channels with a safe fallback signal", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-1",
      { onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    const tileChannel = FakePeerConnection.latest.channels.get("wonremote-tiles");
    const controlChannel = FakePeerConnection.latest.channels.get("wonremote-control");
    const fileChannel = FakePeerConnection.latest.channels.get("wonremote-files");
    expect(tileChannel?.options).toMatchObject({ ordered: false });
    expect(controlChannel?.options).toMatchObject({ ordered: true });
    expect(fileChannel?.options).toMatchObject({ ordered: true });
    expect(firestoreMocks.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(firestoreMocks.limit).toHaveBeenCalledWith(20);
    expect(transport.isControlReady()).toBe(false);
    expect(transport.sendControl("key-down Ctrl")).toBe(true);
    expect(controlChannel!.send).not.toHaveBeenCalled();

    controlChannel!.readyState = "open";
    controlChannel!.onopen?.();
    expect(transport.isControlReady()).toBe(true);
    expect(controlChannel!.send).toHaveBeenCalledOnce();
    expect(parseWebRtcControlAction(controlChannel!.send.mock.calls[0][0])).toBe("key-down Ctrl");
    expect(transport.sendControl("key-up Ctrl")).toBe(true);
    expect(parseWebRtcControlAction(controlChannel!.send.mock.calls[1][0])).toBe("key-up Ctrl");

    fileChannel!.readyState = "open";
    fileChannel!.onopen?.();
    const onProgress = vi.fn();
    const filePromise = transport.sendFile({
      file: new Blob([new Uint8Array([1, 2, 3])]),
      filename: "folder/example.bin",
      fileSha256: "a".repeat(64),
      transferId: "transfer-1",
      onProgress,
    });
    await vi.waitFor(() => expect(fileChannel!.send).toHaveBeenCalledOnce());
    expect(parseWebRtcFileChunk(fileChannel!.send.mock.calls[0][0])).toMatchObject({
      filename: "folder/example.bin",
      transferId: "transfer-1",
    });
    fileChannel!.onmessage?.({
      data: serializeWebRtcFileAck({
        type: "file-ack",
        transferId: "transfer-1",
        receivedBytes: 3,
        receivedChunks: 1,
        status: "complete",
      }),
    });
    await expect(filePromise).resolves.toBe(true);
    expect(onProgress).toHaveBeenCalledWith(3, 3);

    const clipboardPromise = transport.sendFile({
      file: new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }),
      filename: "wonremote-clipboard.png",
      fileSha256: "b".repeat(64),
      transferId: "clipboard-1",
      purpose: "clipboard-image",
      mimeType: "image/png",
    });
    await vi.waitFor(() => expect(fileChannel!.send).toHaveBeenCalledTimes(2));
    expect(parseWebRtcFileChunk(fileChannel!.send.mock.calls[1][0])).toMatchObject({
      transferId: "clipboard-1",
      purpose: "clipboard-image",
      mimeType: "image/png",
    });
    fileChannel!.onmessage?.({
      data: serializeWebRtcFileAck({
        type: "file-ack",
        transferId: "clipboard-1",
        receivedBytes: 3,
        receivedChunks: 1,
        status: "complete",
      }),
    });
    await expect(clipboardPromise).resolves.toBe(true);

    tileChannel!.readyState = "open";
    tileChannel!.onopen?.();
    expect(parseWebRtcControlAction(controlChannel!.send.mock.calls[2][0])).toBe("request-keyframe");
    tileChannel!.onclose?.();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("data-channel-closed") }));

    transport.close();
    expect(FakePeerConnection.latest.close).toHaveBeenCalledOnce();
    expect(transport.isControlReady()).toBe(false);
    expect(transport.sendControl("key-up Ctrl")).toBe(false);
  });

  it("exposes an ordered control queue before the Firestore offer write finishes", async () => {
    let finishOfferWrite: (() => void) | undefined;
    firestoreMocks.safeSetDoc.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishOfferWrite = () => resolve(undefined);
    }));
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    let resolvedTransport: Awaited<ReturnType<typeof startFirebaseViewerWebRtcTransport>> | undefined;

    const transportPromise = startFirebaseViewerWebRtcTransport(
      "session-fast-start",
      { onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    void transportPromise.then((transport) => {
      resolvedTransport = transport;
    });

    await vi.waitFor(() => expect(firestoreMocks.safeSetDoc).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(resolvedTransport).toBeDefined();
    expect(resolvedTransport!.sendControl("key-down Backspace")).toBe(true);

    const controlChannel = FakePeerConnection.latest.channels.get("wonremote-control")!;
    expect(controlChannel.send).not.toHaveBeenCalled();
    controlChannel.readyState = "open";
    controlChannel.onopen?.();
    expect(parseWebRtcControlAction(controlChannel.send.mock.calls[0][0])).toBe("key-down Backspace");

    finishOfferWrite?.();
    const transport = await transportPromise;
    transport.close();
  });

  it("keeps the startup watchdog active until both tile and control channels open", async () => {
    vi.useFakeTimers();
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-missing-control",
      { onError, onFrame: vi.fn() },
      { VITE_WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "2000" } as unknown as ImportMetaEnv,
    );

    const tileChannel = FakePeerConnection.latest.channels.get("wonremote-tiles")!;
    tileChannel.readyState = "open";
    tileChannel.onopen?.();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("without open tile and control channels"),
    }));
    expect(transport.isControlReady()).toBe(false);
    expect(transport.sendControl("key-down A")).toBe(false);
  });

  it("keeps a healthy connection alive when one trickle ICE candidate write fails", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onDiagnostic = vi.fn();
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-candidate-warning",
      { onDiagnostic, onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    const peer = FakePeerConnection.latest;
    const tileChannel = peer.channels.get("wonremote-tiles")!;
    const controlChannel = peer.channels.get("wonremote-control")!;
    tileChannel.readyState = "open";
    controlChannel.readyState = "open";
    tileChannel.onopen?.();
    controlChannel.onopen?.();

    firestoreMocks.safeAddDoc.mockRejectedValueOnce(new Error("candidate write denied"));
    peer.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "candidate:1" }) } as RTCIceCandidate,
    });
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("viewer-candidate-write-failed"),
    ));

    expect(onError).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    expect(transport.sendControl("key-down A")).toBe(true);
    transport.close();
  });

  it("queues Agent ICE candidates until the matching Answer remote description is applied", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-candidate-before-answer",
      { onDiagnostic: vi.fn(), onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    await vi.waitFor(() => expect(firestoreMocks.safeSetDoc).toHaveBeenCalledOnce());

    const peer = FakePeerConnection.latest;
    let remoteDescriptionApplied = false;
    let completeRemoteDescription: (() => void) | undefined;
    const successfullyAppliedCandidates: RTCIceCandidateInit[] = [];
    peer.setRemoteDescription.mockImplementationOnce(() => new Promise<void>((resolve) => {
      completeRemoteDescription = () => {
        remoteDescriptionApplied = true;
        resolve();
      };
    }));
    peer.addIceCandidate.mockImplementation(async (candidate?: RTCIceCandidateInit) => {
      if (!remoteDescriptionApplied) {
        throw new Error("Remote description must be applied before ICE candidates.");
      }
      if (candidate) {
        successfullyAppliedCandidates.push(candidate);
      }
    });

    const offerWrite = firestoreMocks.safeSetDoc.mock.calls[0] as unknown as [
      unknown,
      { offer: { negotiationId: string } },
    ];
    const negotiationId = offerWrite[1].offer.negotiationId;
    const signalCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-before-answer/webrtc/signal",
    )?.[1];
    const candidateCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-before-answer/agentCandidates",
    )?.[1];
    expect(signalCallback).toBeTypeOf("function");
    expect(candidateCallback).toBeTypeOf("function");

    const candidate = { candidate: "candidate:agent-before-answer" };
    candidateCallback?.({
      docs: [{
        id: "agent-candidate-before-answer",
        data: () => ({ candidate, negotiationId }),
      }],
    });
    await Promise.resolve();
    expect.soft(peer.addIceCandidate).not.toHaveBeenCalled();

    signalCallback?.({
      data: () => ({
        answer: { type: "answer", sdp: "agent-answer", negotiationId },
        negotiationId,
      }),
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    completeRemoteDescription?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect.soft(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    expect.soft(successfullyAppliedCandidates).toEqual([candidate]);
    transport.close();
  });

  it("automatically retries an Agent ICE candidate once after its first post-Answer application fails", async () => {
    vi.useFakeTimers();
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onDiagnostic = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-candidate-retry",
      { onDiagnostic, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(firestoreMocks.safeSetDoc).toHaveBeenCalledOnce();

    const peer = FakePeerConnection.latest;
    const offerWrite = firestoreMocks.safeSetDoc.mock.calls[0] as unknown as [
      unknown,
      { offer: { negotiationId: string } },
    ];
    const negotiationId = offerWrite[1].offer.negotiationId;
    const signalCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-retry/webrtc/signal",
    )?.[1];
    const candidateCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-retry/agentCandidates",
    )?.[1];
    expect(signalCallback).toBeTypeOf("function");
    expect(candidateCallback).toBeTypeOf("function");

    signalCallback?.({
      data: () => ({
        answer: { type: "answer", sdp: "agent-answer", negotiationId },
        negotiationId,
      }),
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();

    peer.addIceCandidate
      .mockRejectedValueOnce(new Error("transient candidate rejection"))
      .mockResolvedValueOnce(undefined);
    const candidateSnapshot = {
      docs: [{
        id: "agent-candidate-retry",
        data: () => ({
          candidate: { candidate: "candidate:agent-retry" },
          negotiationId,
        }),
      }],
    };

    candidateCallback?.(candidateSnapshot);
    await Promise.resolve();
    await Promise.resolve();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("agent-candidate-rejected"),
    );
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(2);

    candidateCallback?.(candidateSnapshot);
    await Promise.resolve();
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("stops before sending the next file chunk when its AbortSignal is cancelled", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-file-cancel",
      { onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    const fileChannel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    fileChannel.readyState = "open";
    fileChannel.onopen?.();
    const controller = new AbortController();
    fileChannel.send.mockImplementationOnce(() => {
      controller.abort();
    });
    const file = new Blob([new Uint8Array(WEBRTC_FILE_CHUNK_BYTES * 2)]);

    const transferPromise = transport.sendFile({
      file,
      filename: "large.bin",
      fileSha256: "a".repeat(64),
      signal: controller.signal,
      transferId: "transfer-cancel",
    });

    await expect(transferPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(fileChannel.send).toHaveBeenCalledOnce();
    transport.close();
  });

  it("does not tear down a peer for a transient disconnected state", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-transient-disconnect",
      { onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    const peer = FakePeerConnection.latest;
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();

    expect(onError).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    transport.close();
  });

  it("closes a saturated pre-open queue before allowing Firestore fallback", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-control-overflow",
      { onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    for (let index = 0; index < 2_048; index += 1) {
      expect(transport.sendControl(`key-down Repeat${index}`)).toBe(true);
    }
    expect(transport.sendControl("key-up Repeat2047")).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("control-queue-overflow"),
    }));
    expect(transport.sendControl("key-release-all")).toBe(false);
  });
});
