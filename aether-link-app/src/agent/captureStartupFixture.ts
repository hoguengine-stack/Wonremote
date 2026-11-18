import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { vi } from "vitest";
import { isCurrentWebRtcSessionGeneration } from "./agentCommandExecution";
import { beginAgentCaptureGeneration, shouldCheckDeviceAccessSession } from "./agentSessionLifecycle";
import { GDI_CAPTURE_MIN_INTERVAL_MS } from "./agentStreamPolicy";
import { appendCaptureDiagnostic } from "./captureDiagnostics";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const compile = (text: string) => ts.transpile(text, { target: ts.ScriptTarget.ES2022 });

export function captureStartup({ cloud = true, allowed = true, failAuxiliary = false, failCapture = false } = {}) {
  const events: string[] = [];
  const stderrHandlers: ((chunk: string) => void)[] = [];
  const stdoutHandlers: ((line: string) => Promise<void>)[] = [];
  const fn = (name: string) => {
    const declaration = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === name);
    if (!declaration) throw new Error(`Agent capture function missing: ${name}`);
    return declaration.getText(source);
  };
  const consumeSessionData = vi.fn((_sessionId, _data, isCurrent: () => boolean) => {
    if (isCurrent()) events.push("auxiliary-delivery");
  });
  let deliver = () => {};
  let rejectNextAuxiliary = failAuxiliary;
  const subscribe = vi.fn((_id: string, onData: (data: unknown) => void) => {
    events.push("auxiliary");
    if (rejectNextAuxiliary) {
      rejectNextAuxiliary = false;
      throw new Error("auxiliary unavailable");
    }
    deliver = () => onData({});
    return () => { events.push("auxiliary-stop"); };
  });
  const context = {
    USE_FIREBASE: cloud, process: { platform: cloud ? "win32" : "linux", env: {} }, API_BASE_URL: "http://local", Error, queueMicrotask,
    shouldCheckDeviceAccessSession, beginAgentCaptureGeneration, isCurrentWebRtcSessionGeneration,
    getDeviceAccessLock: async () => ({ publicState: { enabled: true, version: 8 } }),
    isAgentDeviceAccessSessionAllowed: async () => { events.push("admission"); return allowed; },
    authorizedAccessSession: null, readyDeviceAccessLock: { publicState: { version: 8 } },
    activeSessionId: null, captureGeneration: 0, sessionGeneration: 0, selectedUpdateHandoffClaimed: false,
    reverseFileRequest: { cancel() {} }, currentStreamMode: "fast",
    getStreamPerformanceProfile: () => ({ loopSleepMs: 16, jpegQuality: 60, maxMergeWidth: 256, maxBufferedAmount: 512 * 1024 }),
    pendingInitialKeyframe: null, streamDesired: false, streamBackend: "dxgi",
    currentOutputIndex: 0, currentLoopSleepMs: 16, adaptiveCapture: null, AdaptiveCapture: class {},
    nextSecureDesktopCaptureState: () => false, streamSecureDesktop: false, streamTransport: "none",
    resetFirestoreTileFallbackBudget() {}, streamDroppedFrameCount: 0, streamBackpressured: false,
    streamBufferedAmount: 0, streamFrameSequence: 0, currentStreamProfile: null,
    streamRestartCount: 0, streamFailureCount: 0, lastStreamFrameAt: undefined, lastStreamError: undefined,
    rtcState: "none", rtcError: undefined, appendCaptureDiagnostic,
    confirmedGdiCaptureGeneration: null, GDI_CAPTURE_MIN_INTERVAL_MS,
    streamProcess: null, streamRestartTimer: null, keyframeRetryTimer: null,
    webRtcTransport: null, webRtcTransportStartGeneration: null, sessionDataUnsubscribe: null,
    releasePressedInputAndClose: async () => { events.push("release-input"); },
    persistentInputInjector: {}, pointerState: {}, pressedKeys: new Set(),
    POC_PATH: "capture.exe", ensureSessionWebRtcTransport() { if (cloud) events.push("signaling"); },
    resolveAgentCaptureSpawnPlan: () => ({ args: [], secure: false }),
    markConnectionTiming: vi.fn(),
    performance, setTimeout, clearTimeout, updateAdaptiveStreamProfile() {},
    writeCaptureControl: vi.fn((_input: unknown, _command: string, _fail: (error: Error) => void, onWritten?: () => void) => {
      onWritten?.();
      return true;
    }),
    spawn() {
      events.push("capture");
      if (failCapture) throw new Error("capture unavailable");
      return { stdin: {}, stdout: {}, stderr: { on(_event: string, handler: (chunk: string) => void) { stderrHandlers.push(handler); } },
        kill() { events.push("capture-stop"); }, on() {} };
    },
    observeCaptureControlErrors: () => () => {},
    readline: { createInterface: () => ({ on(_event: string, handler: (line: string) => Promise<void>) {
      events.push("picture-handler");
      stdoutHandlers.push(handler);
    } }) },
    console: { log() {}, error: vi.fn(), warn: vi.fn() }, consumeSessionData,
    subscribeAgentSessionData: subscribe,
    subscribeLocalSessionData: (_base: string, id: string, _target: string, onData: (data: unknown) => void) => subscribe(id, onData),
  };
  const start: (deviceId: string, sessionId: string) => Promise<void> = runInNewContext(
    compile(`${fn("startStreaming")}\n${fn("startSessionData")}\n${fn("flushPendingInitialKeyframe")}\nstartStreaming;`), context,
  );
  const readDiagnostics = () => runInNewContext(compile(`${fn("buildStreamDiagnostics")}\nbuildStreamDiagnostics();`),context);
  return { start, events, context, subscribe, getDelivery: () => deliver, stderrHandlers, stdoutHandlers, readDiagnostics };
}
