import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentCommandPollGate, createSerializedAgentCommandQueue, executeAgentCommand, isCurrentWebRtcSessionGeneration } from "./agentCommandExecution";
import { createAgentPointerState, recordPendingPointerAction, recordSuccessfulPointerAction } from "./agentPointerState";
import { isStaleSessionInputCommand } from "./agentSessionLifecycle";
import { updateTelemetryStateKey } from "./agentUpdatePollPolicy";
import { captureStartup } from "./captureStartupFixture";
import { firebaseCommandListenerRetryDelayMs, firebaseRequestRetryDelayMs } from "../firebase/requestRetryPolicy";
import { decideUpdateEligibility } from "../domain/updateFleetPolicy";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!result && predicate(node)) result = node; else ts.forEachChild(node, visit); };
  visit(source);
  if (!result) throw new Error("Agent lifecycle block missing");
  return result;
}
const compile = (text: string) => ts.transpile(text, { target: ts.ScriptTarget.ES2022 });
function heartbeatRuntimeSource() {
  const names = new Set(["sendHeartbeat","readHeartbeatDiagnostics","HEARTBEAT_DIAGNOSTICS_WAIT_MS","DIAGNOSTICS_CACHE_AGE_MS","heartbeatDiagnosticsInFlight"]);
  return source.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(source)))),
  ).map(node => node.getText(source)).join("\n");
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("installed Agent selected update handoff", () => {
  it.each(["authorized", "selection withdrawn", "device paused", "busy", "policy unavailable", "latest fallback revoked"])(
    "never launches a selected update outside the active policy: %s", async scenario => {
      const sourceCheck = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "checkUpdate");
      const rollout = { targetVersion: "0.1.125", stage: "general", percentage: 0, targetDeviceIds: ["chosen"] };
      const initial = { rollout, updatePaused: false, updateRing: "general" };
      const fresh = scenario === "selection withdrawn" || scenario === "latest fallback revoked" ? { ...initial, rollout: { ...rollout, targetDeviceIds: ["other"] } }
        : scenario === "device paused" ? { ...initial, updatePaused: true } : initial;
      const loadPolicy = vi.fn(async () => {
        if (scenario === "policy unavailable" || scenario === "latest fallback revoked") throw new Error("offline");
        return rollout;
      });
      const metadata = vi.fn(async (_id, _current, policy) => policy
        ? { selected: true, metadata: { latestVersion: "0.1.125" } }
        : { selected: false, metadata: { latestVersion: scenario === "latest fallback revoked" ? "0.1.125" : "0.1.124" } });
      const loadRollout = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
      const startInstaller = vi.fn();
      const handoff = vi.fn(async (_data, _config, _retry, beforeLaunch: () => Promise<void>) => {
        await beforeLaunch();
        startInstaller();
      });
      const context = { USE_FIREBASE: true, process: { platform: "win32", env: { WONREMOTE_PACKAGE_KIND: "installer" } },
        agentHealthReporter: { isHealthy: () => true }, isUpdating: false, lastUpdateCheckAttemptAtMs: null,
        UPDATE_CHECK_INTERVAL_MS: 3_600_000, WONREMOTE_APP_VERSION: "0.1.124", currentUpdateTelemetry: { state: "idle" },
        shouldAttemptAgentUpdateCheck: () => true, setUpdateTelemetry: vi.fn(), scheduleAgentUpdateRetry: vi.fn(),
        loadAgentUpdateRolloutPolicyWithFirebase: loadPolicy, loadProductionAgentUpdateCandidate: metadata,
        loadAgentUpdateRolloutWithFirebase: loadRollout, isHigherVersion: (latest: string) => latest === "0.1.125",
        activeSessionId: scenario === "busy" ? "fallback-session" : null, rtcState: "unavailable", stopSessionPolling: vi.fn(), remoteUpdateRequest: { defer: vi.fn() },
        selectedUpdateHandoffClaimed: false, shouldDeferAgentUpdateForSession: () => false,
        prepareAgentUpdateSession: async () => "ready", decideUpdateEligibility,
        isPortableUpdateMetadata: () => false, isInstallerUpdateMetadata: () => true,
        handoffToProductionInstallerUpdate: handoff, console: { log: vi.fn(), error: vi.fn() },
      };
      const run = runInNewContext(compile(`${sourceCheck.getText(source)}\ncheckUpdate;`), context);
      await Promise.all([run({ registeredDeviceId: "chosen" }), run({ registeredDeviceId: "chosen" })]);
      expect(loadPolicy).toHaveBeenCalledTimes(1);
      expect(metadata).toHaveBeenCalledTimes(1);
      if (scenario === "busy" || scenario === "policy unavailable") {
        expect(loadRollout).not.toHaveBeenCalled();
        expect(handoff).not.toHaveBeenCalled();
        expect(context.remoteUpdateRequest.defer).toHaveBeenCalledTimes(scenario === "busy" ? 1 : 0);
      } else {
        expect(loadRollout.mock.calls).toEqual([["chosen", undefined, scenario !== "latest fallback revoked"], ["chosen", undefined, true]]);
        expect(handoff).toHaveBeenCalledTimes(1);
      }
      expect(startInstaller).toHaveBeenCalledTimes(scenario === "authorized" ? 1 : 0);
    },
  );

  it("rechecks selection after preparation and before dispatch to the protected broker", async () => {
    const node = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "handoffToProductionInstallerUpdate");
    const dispatch = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "releaseInputAndCompleteUpdateHandoff");
    const write = vi.fn();
    const releaseInput = vi.fn();
    const prepare = vi.fn();
    const timed = vi.fn((run: () => void) => { run(); });
    const context = { process: { env: { APPDATA: "local-appdata" }, stdout: { write } }, USE_FIREBASE: true, activeSessionId: null, rtcState: "none",
      stopSessionPolling: vi.fn(), prepareAgentUpdateSession: async () => "ready", setUpdateTelemetry: vi.fn(),
      downloadInstallerUpdate: async () => ({ installerPath: "trial.exe", installerArgs: [] }),
      prepareInstallerHandoff: prepare.mockResolvedValue({ scriptPath: "handoff.ps1", protectedAcknowledgementPath: "ack" }),
      isUpdateHandoffBrokerEnabled: () => true, streamProcess: null, selectedUpdateHandoffClaimed: false,
      agentCommandQueue: { enqueue: async (task: () => unknown) => task() }, releasePressedInputAndClose: releaseInput,
      persistentInputInjector: {}, pointerState: {}, pressedKeys: new Set(), formatPreparedUpdateHandoff: () => "dispatch",
      setTimeout: timed, console: { log: vi.fn() } };
    const handoff = runInNewContext(compile(`${dispatch.getText(source)}\n${node.getText(source)}\nhandoffToProductionInstallerUpdate;`), context);
    const revoked = vi.fn(async () => {
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(timed).toHaveBeenCalledTimes(1);
      expect(releaseInput).toHaveBeenCalledTimes(1);
      expect(context.selectedUpdateHandoffClaimed).toBe(true);
      throw new Error("selection revoked while preparing");
    });
    await expect(handoff({ latestVersion: "0.1.125" }, {}, vi.fn(), revoked, false, true)).rejects.toThrow("selection revoked");
    expect(write).not.toHaveBeenCalled();
  });

  it("ignores the cached policy, bounds a stalled read and unsubscribes", async () => {
    vi.useFakeTimers();
    const firebase = ts.createSourceFile("agentFirebase.ts", readFileSync(new URL("../firebase/agentFirebase.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const node = firebase.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "readAgentUpdateServerDocument")!;
    const unsubscribe = vi.fn();
    let next: (doc: { metadata: { fromCache: boolean } }) => void = () => {};
    const onSnapshot = vi.fn((_ref, _options, callback: typeof next) => { next = callback; return unsubscribe; });
    const read = runInNewContext(compile(`${node.getText(firebase)}\nreadAgentUpdateServerDocument;`), { onSnapshot, setTimeout, clearTimeout });
    const pending = read({});
    const timeout = expect(pending).rejects.toThrow("timed out");
    next({ metadata: { fromCache: true } });
    expect(unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await timeout;
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("Agent first capture handoff", () => {
  it("does not admit a new remote session while a selected update is being accepted", async () => {
    const { start, context, events } = captureStartup();
    context.selectedUpdateHandoffClaimed = true;
    await expect(start("device", "during-update")).rejects.toThrow("update handoff is in progress");
    expect(events).not.toContain("capture");
    context.selectedUpdateHandoffClaimed = false;
    await start("device", "after-update-failure");
    expect(events).toContain("capture");
  });

  it("starts the admitted picture before auxiliary listeners and reuses their owner across capture restarts", async () => {
    const { start, events, getDelivery } = captureStartup();
    await start("device", "old");
    expect(events).toEqual(["admission", "signaling", "capture", "picture-handler", "auxiliary"]);
    const oldDelivery = getDelivery();
    oldDelivery();
    expect(events.pop()).toBe("auxiliary-delivery");
    events.length = 0;
    await start("device", "old");
    expect(events).toEqual(["capture-stop", "signaling", "capture", "picture-handler"]);
    events.length = 0;
    await start("device", "new");
    oldDelivery();
    expect(events).toEqual(["admission", "capture-stop", "auxiliary-stop", "release-input", "signaling", "capture", "picture-handler", "auxiliary"]);
    getDelivery()();
    expect(events.pop()).toBe("auxiliary-delivery");
  });

  it("does not open picture or auxiliary listeners when admission is denied", async () => {
    const { start, events } = captureStartup({ allowed: false });
    await expect(start("device", "locked")).rejects.toThrow();
    expect(events).toEqual(["admission"]);
  });

  it("reports the selected GDI cadence without carrying it to a replacement capture", async () => {
    const { start, stderrHandlers, readDiagnostics, context } = captureStartup();
    await start("device", "session");
    const original = stderrHandlers[0];
    original("DXGI capture init failed. Falling back to GDI BitBlt capture.\n");
    expect(readDiagnostics()).toMatchObject({ backend: "dxgi", loopSleepMs: 16 });
    original("Capture backend: G");
    original("DI / DISPLAY1 (1920x1080)\r\n");
    expect(readDiagnostics()).toMatchObject({ backend: "gdi", loopSleepMs: 125 });
    expect(context.streamBackend).toBe("dxgi");
    expect(context.currentLoopSleepMs).toBe(16);
    context.currentLoopSleepMs = 200;
    expect(readDiagnostics().loopSleepMs).toBe(200);
    await start("device", "session");
    original("Capture backend: GDI / DISPLAY1 (1920x1080)\n");
    expect(readDiagnostics()).toMatchObject({ backend: "dxgi", loopSleepMs: 33 });
  });

  it("recognizes current GDI startup multiplexed onto broker stdout", async () => {
    const { start, stdoutHandlers, readDiagnostics } = captureStartup();
    await start("device", "session");
    await stdoutHandlers[0]("DXGI failed. Falling back to GDI.");
    expect(readDiagnostics()).toMatchObject({ backend: "dxgi", loopSleepMs: 16 });
    await stdoutHandlers[0]("Capture backend: GDI / DISPLAY1 (1920x1080)");
    expect(readDiagnostics()).toMatchObject({ backend: "gdi", loopSleepMs: 125 });
  });

  async function backpressuredCapture() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { start, stdoutHandlers, context } = captureStartup();
    await start("device", "session");
    const write = context.writeCaptureControl;
    let sendResult: "sent" | "backpressure" = "backpressure";
    let bufferedAmount = 0;
    const sendFrame = vi.fn(() => sendResult);
    Object.assign(context, { webRtcTransport: { sendFrame, getBufferedAmount: () => bufferedAmount } });
    const frame = (result: typeof sendResult, bytes: number, keyframe = false, child = stdoutHandlers.length - 1) => {
      sendResult = result;
      bufferedAmount = bytes;
      return stdoutHandlers[child](JSON.stringify({ type: "frame", tiles: [], width: 64, height: 32, keyframe }));
    };
    return { start, frame, write, sendFrame, hasScheduledRecovery: () => context.keyframeRetryTimer !== null };
  }

  it("repairs dropped pixels as soon as a low-backlog delta sends, without increasing the recovery rate", async () => {
    const { frame, write } = await backpressuredCapture();
    await frame("sent", 0);
    expect(write).not.toHaveBeenCalled();
    await frame("backpressure", 512 * 1024);
    await vi.advanceTimersByTimeAsync(16);
    await frame("sent", 400 * 1024);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    await frame("sent", 16 * 1024);
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.anything(), "request-keyframe\n", expect.any(Function), expect.any(Function));
    await vi.advanceTimersByTimeAsync(8);
    await frame("backpressure", 512 * 1024);
    await frame("sent", 16 * 1024);
    await vi.advanceTimersByTimeAsync(249);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("cancels queued picture repair after a complete picture or capture replacement", async () => {
    const { start, frame, write, hasScheduledRecovery } = await backpressuredCapture();
    await frame("backpressure", 512 * 1024);
    expect(hasScheduledRecovery()).toBe(true);
    await frame("sent", 512 * 1024, true);
    await vi.advanceTimersByTimeAsync(250);
    expect(write).not.toHaveBeenCalled();
    await frame("backpressure", 512 * 1024);
    await start("device", "session");
    await frame("backpressure", 512 * 1024, false, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(write).not.toHaveBeenCalled();
  });

  it("retains the scheduled recovery when the early native request is rejected", async () => {
    const { frame, write, hasScheduledRecovery } = await backpressuredCapture();
    await frame("backpressure", 512 * 1024);
    await vi.advanceTimersByTimeAsync(32);
    write.mockReturnValueOnce(false);
    await frame("sent", 16 * 1024);
    expect(write).toHaveBeenCalledTimes(1);
    expect(hasScheduledRecovery()).toBe(true);
    await frame("sent", 16 * 1024);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(218);
    expect(write).toHaveBeenCalledTimes(2);
    expect(hasScheduledRecovery()).toBe(false);
  });

  it.each(["written", "failed", "replaced"] as const)("does not duplicate a pending early capture write (%s)", async outcome => {
    const { start, frame, write, hasScheduledRecovery } = await backpressuredCapture();
    await frame("backpressure", 512 * 1024);
    await vi.advanceTimersByTimeAsync(32);
    let finish!: () => void;
    write.mockImplementationOnce((_input, _command, fail, written) => {
      finish = outcome === "written" ? written! : () => fail(new Error("EPIPE fixture"));
      return true;
    });
    await frame("sent", 16 * 1024);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(218);
    expect(write).toHaveBeenCalledTimes(1);
    expect(hasScheduledRecovery()).toBe(true);
    if (outcome === "replaced") {
      await start("device", "session");
      await frame("backpressure", 512 * 1024);
      finish();
      expect(hasScheduledRecovery()).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(hasScheduledRecovery()).toBe(false);
      expect(write).toHaveBeenCalledTimes(2);
      return;
    }
    finish();
    expect(hasScheduledRecovery()).toBe(false);
    expect(write).toHaveBeenCalledTimes(outcome === "failed" ? 2 : 1);
  });

  it("keeps an unsent full picture when the early capture write completes later", async () => {
    const { frame, write, hasScheduledRecovery, sendFrame } = await backpressuredCapture();
    await frame("backpressure", 512 * 1024);
    await vi.advanceTimersByTimeAsync(32);
    let finish!: () => void;
    write.mockImplementationOnce((_input, _command, _fail, written) => {
      finish = written!;
      return true;
    });
    await frame("sent", 16 * 1024);
    await frame("backpressure", 512 * 1024, true);
    finish();
    expect(hasScheduledRecovery()).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(sendFrame).toHaveBeenCalledTimes(3);
    sendFrame.mockReturnValueOnce("sent");
    await vi.advanceTimersByTimeAsync(1);
    expect(sendFrame).toHaveBeenLastCalledWith(expect.objectContaining({ keyframe: true }));
    expect(sendFrame).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledTimes(1);
    expect(hasScheduledRecovery()).toBe(false);
  });

  it("keeps an admitted session's auxiliary listener when capture startup throws", async () => {
    const { start, events, getDelivery } = captureStartup({ failCapture: true });
    await expect(start("device", "capture-failed")).rejects.toThrow("capture unavailable");
    getDelivery()();
    expect(events).toEqual(["admission", "signaling", "capture", "auxiliary", "auxiliary-delivery"]);
  });

  it("does not register queued auxiliary work for a superseded session", async () => {
    const { start, subscribe } = captureStartup();
    await Promise.all([start("device", "superseded"), start("device", "current")]);
    expect(subscribe).toHaveBeenCalledExactlyOnceWith("current", expect.any(Function), expect.any(Function));
  });

  it("starts local capture without duplicate auxiliary requests and isolates subscriber startup failure", async () => {
    const { start, events, context, getDelivery } = captureStartup({ cloud: false, failAuxiliary: true });
    await start("device", "local");
    expect(events).toEqual(["capture", "picture-handler", "auxiliary"]);
    expect(context.console.error).toHaveBeenCalledExactlyOnceWith("[Agent session data] auxiliary unavailable");
    events.length = 0;
    await start("device", "local");
    await start("device", "local");
    getDelivery()();
    expect(events).toEqual(["capture-stop", "capture", "picture-handler", "auxiliary",
      "capture-stop", "capture", "picture-handler", "auxiliary-delivery"]);
  });

  it.each([
    {name:"latest picture", bufferedGeneration:3, idleReplacementAvailable:false, sends:true},
    {name:"newer normal desktop picture is available", bufferedGeneration:3, idleReplacementAvailable:true, sends:false},
    {name:"picture from another session", bufferedGeneration:2, idleReplacementAvailable:false, sends:false},
  ])("selects the initial full picture when WebRTC opens: $name", async ({bufferedGeneration, idleReplacementAvailable, sends}) => {
    const flush = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "flushPendingInitialKeyframe");
    const ensure = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "ensureSessionWebRtcTransport");
    const frame = {width:64,height:32,tiles:["fixture"],sequence:17,keyframe:true};
    const sendFrame = vi.fn(() => "sent"), writeCaptureControl = vi.fn(() => true);
    const markConnectionTiming = vi.fn();
    let onState!: (state: string) => void;
    const startTransport = vi.fn(async (_session: string, handlers: {onState: (state: string) => void}) => {
      onState = handlers.onState;
      return {sendFrame, getBufferedAmount:() => 0, close:vi.fn(async () => {})};
    });
    const context = {
      USE_FIREBASE:true, activeSessionId:"capture-1", sessionGeneration:3,
      pendingInitialKeyframe:{sessionGeneration:bufferedGeneration,frame,idleReplacementAvailable},
      webRtcTransport:null, webRtcTransportStartGeneration:null,
      streamProcess:{stdin:{}}, streamDesired:true, keyframeRetryTimer:null,
      rtcState:"none", rtcError:undefined, streamTransport:"none", streamBackpressured:false, streamBufferedAmount:0,
      isCurrentWebRtcSessionGeneration:(expected:number, current:number, session:string, active:string) =>
        expected === current && session === active,
      startAgentWebRtcTransportWithFirebase:startTransport, writeCaptureControl, markConnectionTiming, console:{log:vi.fn()},
    };
    runInNewContext(compile(`${flush.getText(source)}\n${ensure.getText(source)}
      ensureSessionWebRtcTransport("device-1", "capture-1", 3);`), context);
    await Promise.resolve();
    onState("open");
    onState("open");
    expect(startTransport).toHaveBeenCalledOnce();
    if (sends) {
      expect(sendFrame).toHaveBeenCalledExactlyOnceWith(frame);
      expect(writeCaptureControl).not.toHaveBeenCalled();
      expect(markConnectionTiming).toHaveBeenCalledWith("capture-1","first-frame-sent");
    } else {
      expect(sendFrame).not.toHaveBeenCalled();
      expect(writeCaptureControl).toHaveBeenCalledExactlyOnceWith(context.streamProcess.stdin, "request-keyframe\n", expect.any(Function));
      expect(markConnectionTiming).not.toHaveBeenCalledWith("capture-1","first-frame-sent");
    }
    expect(context.pendingInitialKeyframe).toBeNull();
  });

  it.each([true, false, undefined])("recovers a backed-up capture after idle replacement availability=%s", async idleKeyframeAvailable => {
    vi.useFakeTimers();
    const { start, stdoutHandlers, context } = captureStartup();
    await start("device", "capture-1");
    const sendFrame = vi.fn(() => "backpressure");
    const { writeCaptureControl, markConnectionTiming } = context;
    Object.assign(context, { webRtcTransport: { sendFrame, getBufferedAmount: () => 512 * 1024 } });
    const onLine = stdoutHandlers[0];
    const frame = (keyframe:boolean) => JSON.stringify({type:"frame",width:64,height:32,tiles:["fixture"],keyframe,
      ...(keyframe ? {} : {idleKeyframeAvailable})});
    await onLine(frame(true));
    await onLine(frame(false));
    expect(sendFrame).toHaveBeenCalledTimes(2);
    sendFrame.mockReturnValueOnce("sent");
    await vi.advanceTimersByTimeAsync(250);
    if (idleKeyframeAvailable) {
      expect(sendFrame).toHaveBeenCalledTimes(2);
      expect(writeCaptureControl).toHaveBeenCalledExactlyOnceWith(expect.anything(), "request-keyframe\n", expect.any(Function), undefined);
      expect(markConnectionTiming).not.toHaveBeenCalledWith("capture-1","first-frame-sent");
      await onLine(frame(true));
      expect(sendFrame).toHaveBeenLastCalledWith(expect.objectContaining({sequence:3,keyframe:true}), undefined);
    } else {
      expect(writeCaptureControl).not.toHaveBeenCalled();
      expect(sendFrame).toHaveBeenLastCalledWith(expect.objectContaining({sequence:1,keyframe:true}));
    }
    expect(markConnectionTiming).toHaveBeenCalledWith("capture-1","first-frame-sent");
    expect(context.pendingInitialKeyframe).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Agent motion logging", () => {
  it.each([
    { secondChannelLive: true, replaceSession: false },
    { secondChannelLive: false, replaceSession: false },
    { secondChannelLive: true, replaceSession: true },
  ])("keeps the input queue moving while an authorized clipboard snapshot is being published (live: $secondChannelLive, replaced: $replaceSession)", async ({ secondChannelLive, replaceSession }) => {
    const factory = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "createAgentCommandRuntime");
    const ensure = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "ensureSessionWebRtcTransport");
    let finishRead!: (text: string) => void;
    let rejectWrite!: (error: Error) => void;
    const read = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
      .mockResolvedValue("second fixture value");
    const post = vi.fn<(sessionId: string, payload: unknown) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWrite = reject; }))
      .mockResolvedValue(undefined);
    const inject = vi.fn(async (_action: string) => {});
    const queue = createSerializedAgentCommandQueue();
    let control!: (action: string, isCurrent: (requireOpen?: boolean) => boolean) => void;
    const context = {
      USE_FIREBASE: true, activeSessionId: "clipboard-session", pendingClipboardPublication: null,
      sessionGeneration: 1, streamProcess: null, webRtcTransport: null, webRtcTransportStartGeneration: null,
      rtcState: "none", rtcError: undefined, isCurrentWebRtcSessionGeneration, executeAgentCommand, agentCommandQueue: queue,
      startAgentWebRtcTransportWithFirebase: async (_session: string, handlers: { onControl: typeof control }) => {
        control = handlers.onControl;
        return { isClosed: () => false, close: async () => {} };
      },
      getClipboardText: read, postClipboardWithFirebase: post,
      console: { log: vi.fn(), warn: vi.fn() }, persistentInputInjector: { inject },
      pressedKeys: new Set<string>(), pointerState: createAgentPointerState(), recordPendingPointerAction, recordSuccessfulPointerAction,
      setClipboardText: vi.fn(), showSecurityCode: vi.fn(),
    };
    const { runtime, start } = runInNewContext(compile(`${factory.getText(source)}\n${ensure.getText(source)}
      ensureSessionWebRtcTransport("device", "clipboard-session", 1);
      ({ runtime: createAgentCommandRuntime("device"), start: ensureSessionWebRtcTransport });`), context);
    let current = true;
    const canPublish = () => current;
    const send = (action: string) => {
      control(action, canPublish);
      return queue.enqueue(() => {});
    };
    const first = send("clipboard-request");
    const move = send("move 100 200");
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect(inject).not.toHaveBeenCalled();
      finishRead("first fixture value");
      await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(inject).toHaveBeenCalledExactlyOnceWith("move 100 200"));
      expect(post).toHaveBeenCalledExactlyOnceWith("clipboard-session", { text: "first fixture value", sender: "agent" });
      const currentSession = replaceSession ? "replacement-session" : "clipboard-session";
      if (replaceSession) {
        context.activeSessionId = currentSession;
        context.sessionGeneration++;
        context.webRtcTransport = null;
        start("device", currentSession, context.sessionGeneration);
      }
      const repeat = send(" clipboard-request ");
      const key = send("keypress A");
      await vi.waitFor(() => expect(inject.mock.calls).toEqual([["move 100 200"], ["keypress A"]]));
      expect(read).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledOnce();
      current = secondChannelLive;
      read.mockResolvedValueOnce("fallback fixture value");
      const fallbackStarted = vi.fn();
      const repeatViaFallback = queue.enqueue(() => {
        fallbackStarted();
        return executeAgentCommand("clipboard-request", "poll", runtime);
      });
      await vi.waitFor(() => expect(fallbackStarted).toHaveBeenCalledOnce());
      expect(read).toHaveBeenCalledTimes(2);
      rejectWrite(new Error("test write failure"));
      await Promise.all([first, move, repeat, key, repeatViaFallback]);
      expect(context.console.warn).toHaveBeenCalledExactlyOnceWith("[Clipboard] Could not send the response to the Viewer.");
      expect(post.mock.calls).toEqual([
        ["clipboard-session", { text: "first fixture value", sender: "agent" }],
        ...(secondChannelLive ? [[currentSession, { text: "second fixture value", sender: "agent" }]] : []),
        [currentSession, { text: "fallback fixture value", sender: "agent" }],
      ]);

      current = true;
      read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
      const obsolete = send(" clipboard-request ");
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
      current = false;
      finishRead("obsolete fixture value");
      await obsolete;
      expect(post).toHaveBeenCalledTimes(secondChannelLive ? 3 : 2);
    } finally {
      finishRead?.("cleanup");
      rejectWrite?.(new Error("fixture closed"));
      await Promise.allSettled([first, move]);
    }
  });

  it("reuses one input runtime for sustained WebRTC motion and rejects an obsolete session", async () => {
    const factory = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "createAgentCommandRuntime");
    const ensure = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "ensureSessionWebRtcTransport");
    const queue = createSerializedAgentCommandQueue();
    const failedMove = "move 6000 7000";
    const inject = vi.fn(async (action: string) => { if (action === failedMove) throw new Error("fixture injection failure"); });
    const trackRuntime = vi.fn((runtime: unknown) => runtime);
    type Channel = (requireOpen?: boolean) => boolean;
    const callbacks: ((action: string, isCurrent: Channel) => void)[] = [];
    const closed: ((channel: Channel) => void)[] = [];
    const channels = [() => true, () => true];
    const context = {
      USE_FIREBASE:true, Error, activeSessionId:"session-a", sessionGeneration:1, rtcState:"none", rtcError:undefined,
      webRtcTransport:null, webRtcTransportStartGeneration:null, streamProcess:{stdin:{}},
      startAgentWebRtcTransportWithFirebase:async (_id: string, handlers: {onControl: typeof callbacks[number]; onControlClosed: typeof closed[number]}) => {
        callbacks.push(handlers.onControl);
        closed.push(handlers.onControlClosed);
        return {isClosed:()=>false,close:async()=>{}};
      },
      agentCommandQueue:queue, isCurrentWebRtcSessionGeneration, executeAgentCommand, trackRuntime,
      recordPendingPointerAction, recordSuccessfulPointerAction, pointerState:createAgentPointerState(),
      persistentInputInjector:{inject,prepare:vi.fn(() => {throw new Error("fixture preparation failure");}),discardPreparation:vi.fn()},
      process:{platform:"win32"}, pressedKeys:new Set<string>(),
      writeCaptureControl:vi.fn((_input,_command,_failure,_written?: () => void) => { _written?.(); return true; }),
      releasePressedInput:vi.fn(), reverseFileRequest:{cancel:vi.fn()},
      setClipboardText:vi.fn(), showSecurityCode:vi.fn(), console:{log:vi.fn(),warn:vi.fn(),error:vi.fn()},
    };
    const start = runInNewContext(compile(`${factory.getText(source)}
      const original = createAgentCommandRuntime;
      createAgentCommandRuntime = deviceId => trackRuntime(original(deviceId));
      ${ensure.getText(source)}
      ensureSessionWebRtcTransport;`),context) as (device: string, session: string, generation: number) => void;
    const send = async (index: number, action: string, live = true) => {
      callbacks[index](action, live ? channels[index] : () => false);
      await queue.enqueue(() => {});
    };
    start("device-a","session-a",1);
    await send(0,"move 99 99",false);
    await send(0,"request-keyframe",false);
    expect(context.persistentInputInjector.prepare).not.toHaveBeenCalled();
    await send(0,"request-keyframe");
    await send(0,"request-keyframe");
    expect(context.persistentInputInjector.prepare).toHaveBeenCalledOnce();
    expect(context.writeCaptureControl).toHaveBeenCalledTimes(2);
    expect(context.writeCaptureControl.mock.invocationCallOrder[0])
      .toBeLessThan(context.persistentInputInjector.prepare.mock.invocationCallOrder[0]);
    expect(trackRuntime).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
    const actions = ["mouse-down 1 2 left", ...Array.from({length:300},(_,index)=>`move ${index} ${index+1}`), failedMove, "mouse-up 299 300 left", "keypress A"];
    for (const action of actions) await send(0,action);
    expect(inject.mock.calls.map(([action])=>action)).toEqual(actions);
    expect(trackRuntime).toHaveBeenCalledOnce();
    expect(trackRuntime.mock.calls[0][0]).toMatchObject({deviceId:"device-a"});
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    void queue.enqueue(() => held);
    callbacks[0]("move 999 999", () => true);
    try {
      context.activeSessionId = "session-b"; context.sessionGeneration = 2; context.webRtcTransport = null;
      start("device-b","session-b",2);
    } finally { release(); }
    await send(0,"request-keyframe");
    expect(context.persistentInputInjector.prepare).toHaveBeenCalledOnce();
    context.process.platform = "linux";
    await send(1,"request-keyframe");
    context.process.platform = "win32";
    context.writeCaptureControl.mockReturnValueOnce(false);
    await send(1,"request-keyframe");
    let afterWrite!: () => void;
    const delayAck = () => context.writeCaptureControl.mockImplementationOnce((_input,_command,_failure,written) => { afterWrite = written!; return true; });
    delayAck();
    let live = true;
    callbacks[1]("request-keyframe", () => live);
    await queue.enqueue(() => {});
    live = false;
    afterWrite();
    delayAck();
    await send(1,"request-keyframe");
    context.streamProcess = {stdin:{}};
    afterWrite();
    callbacks[1]("request-keyframe", (requireOpen = false) => !requireOpen);
    await queue.enqueue(() => {});
    expect(context.persistentInputInjector.prepare).toHaveBeenCalledOnce();
    closed[0](channels[0]);
    await queue.enqueue(() => {});
    expect(context.persistentInputInjector.discardPreparation).not.toHaveBeenCalled();
    closed[1](channels[1]);
    await queue.enqueue(() => {});
    expect(context.releasePressedInput).toHaveBeenCalledOnce();
    expect(context.persistentInputInjector.discardPreparation).toHaveBeenCalledExactlyOnceWith(channels[1]);
    await send(1,"move 1 1");
    expect(inject.mock.calls.map(([action])=>action)).toEqual([...actions,"move 1 1"]);
    expect(trackRuntime).toHaveBeenCalledTimes(2);
    expect(trackRuntime.mock.calls[1][0]).toMatchObject({deviceId:"device-b"});
    expect(context.console.error).toHaveBeenCalledExactlyOnceWith("[WebRTC control failed] fixture injection failure");
    expect(context.pointerState).toMatchObject({lastDx:1,lastDy:1,pressedButtons:new Set()});
  });

  it.each(["webrtc", "poll"])("does not log successful motion while preserving the %s input order and failures", async origin => {
    const factory = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "createAgentCommandRuntime");
    const poll = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "executeReceivedCommands");
    const pointerState = createAgentPointerState();
    const log = vi.fn(), error = vi.fn();
    const failedMove = "move 6000 7000";
    const inject = vi.fn(async (action: string) => {
      if (action === failedMove) throw new Error("Input server failure.");
    });
    const down = "mouse-down 1 2 left", up = "mouse-up 599 600 left", key = "keypress A";
    const actions = [down, ...Array.from({length:600}, (_, index) => `move ${index} ${index + 1}`), up, key, failedMove];
    const config = {registeredDeviceId:"fixture"};
    const context = {
      origin, actions, config, Date, Error, pointerState, recordPendingPointerAction, recordSuccessfulPointerAction,
      persistentInputInjector:{inject}, agentCommandQueue:createSerializedAgentCommandQueue(),
      console:{log, error, warn:vi.fn()}, activeSessionId:"fixture-session", USE_FIREBASE:origin === "webrtc",
      pressedKeys:new Set<string>(), setClipboardText:vi.fn(), showSecurityCode:vi.fn(),
      executeAgentCommand, isStaleSessionInputCommand,
    };
    const result = runInNewContext(compile(`${factory.getText(source)}
      ${poll.getText(source)}
      (async () => {
        if (origin === "poll") {
          await executeReceivedCommands(config, actions.map(action => ({action, sessionId:"fixture-session"})));
          return;
        }
        const runtime = createAgentCommandRuntime(config.registeredDeviceId);
        for (const action of actions) await executeAgentCommand(action, "webrtc", runtime);
      })();`), context);
    if (origin === "webrtc") await expect(result).rejects.toThrow("Input server failure.");
    else {
      await result;
      expect(error).toHaveBeenCalledExactlyOnceWith("[Inject Failed] move: Input server failure.");
    }
    expect(inject.mock.calls.map(([action]) => action)).toEqual(actions);
    expect(pointerState).toMatchObject({lastDx:599,lastDy:600,pressedButtons:new Set()});
    expect(log.mock.calls.flat().filter(line => /\bmove\s/.test(line))).toHaveLength(0);
    for (const action of [down, up, key]) expect(log).toHaveBeenCalledWith(`[Inject Success] ${action}`);
  });
});

describe("Windows Agent refresh-only heartbeat runtime", () => {
  it.each(["local", "provided", "missing-path"] as const)("parallelizes diagnostics without changing the %s ZOOK result", async zook => {
    vi.useFakeTimers();
    const delayed = <T,>(value: T, ms: number) => vi.fn(() => new Promise<T>(resolve => setTimeout(() => resolve(value), ms)));
    const discoverDisplays = delayed([{ index: 0, width: 1920, height: 1080 }], 60);
    const discoverControlDiagnostics = delayed({ elevated: true }, 100);
    let localNumber = "01234567";
    const readLocalZookNumber = vi.fn(() => {
      const numberAtRead = localNumber;
      return new Promise<string>(resolve => setTimeout(() => resolve(numberAtRead), 40));
    });
    const sendAgentHeartbeat = vi.fn().mockResolvedValue({ device: { id: "device" } });
    const heartbeatAccepted = vi.fn().mockResolvedValue(undefined);
    const config = { registeredDeviceId: "device", installId: "install", desktopName: "test" };
    const zookResult = zook === "provided" ? { error: "test ZOOK error" } : undefined;
    const getAgentConfigPath = () => {
      if (zook === "missing-path") throw new Error("Working directory unavailable.");
      return "test-config";
    };
    const warn = vi.fn();
    const pending: Promise<void> = runInNewContext(compile(`${heartbeatRuntimeSource()}
      sendHeartbeat(config, "refresh-nonce", zookResult);`), {
      config, zookResult, console: { log: vi.fn(), warn }, process: { platform: "win32" },
      Date, performance:{now:()=>Date.now()},setTimeout,clearTimeout,displayCache:null,controlDiagnosticsCache:null,
      discoverDisplays, discoverControlDiagnostics, readLocalZookNumber, getAgentConfigPath,
      discoverMacAddresses: () => ["00:11:22:33:44:55"], buildStreamDiagnostics: () => ({ running: true }),
      USE_FIREBASE: true, getDeviceAccessLock: vi.fn(), deviceAccessCapability: { accessPublicKey: "test-key" },
      API_BASE_URL: "", WONREMOTE_APP_VERSION: "0.1.1", CURRENT_REMOTE_PROTOCOL_VERSION: 1,
      currentOutputIndex: 0, AGENT_SYSTEM_INFO: {}, currentUpdateTelemetry: { state: "healthy" },
      sendAgentHeartbeat, agentHealthReporter: { heartbeatAccepted },
    });
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(99);
    localNumber = "87654321";
    if (zook === "local") await vi.advanceTimersByTimeAsync(40);
    expect(sendAgentHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendAgentHeartbeat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deviceId: "device", installId: "install", heartbeatRequestId: "refresh-nonce", accessPublicKey: "test-key",
      displays: [{ index: 0, width: 1920, height: 1080 }], controlDiagnostics: { elevated: true },
      zookResult: zook === "local" ? { appliedNumber: "87654321" } : zookResult,
      streamDiagnostics: { running: true }, updateTelemetry: { state: "healthy" },
    }));
    await pending;
    expect(discoverDisplays).toHaveBeenCalledOnce();
    expect(discoverControlDiagnostics).toHaveBeenCalledOnce();
    expect(readLocalZookNumber).toHaveBeenCalledTimes(zook === "local" ? 1 : 0);
    expect(warn).toHaveBeenCalledTimes(zook === "missing-path" ? 1 : 0);
    expect(heartbeatAccepted).toHaveBeenCalledExactlyOnceWith(config, "device");
  });

  it("answers manual refreshes before slow diagnostics without extra heartbeat writes", async () => {
    vi.useFakeTimers();
    const oldDisplays = [{index:0,width:1024,height:768}];
    const newDisplays = [{index:0,width:1920,height:1080}];
    const oldControl = {elevated:false}, newControl = {elevated:true};
    const config = {registeredDeviceId:"device",installId:"install"};
    const sendAgentHeartbeat = vi.fn().mockResolvedValue({device:{id:"device"}});
    const heartbeatAccepted = vi.fn().mockResolvedValue(undefined);
    const context = {
      Date, performance:{now:()=>Date.now()},setTimeout,clearTimeout,console:{log:vi.fn(),warn:vi.fn()},process:{platform:"win32"},
      displayCache:{loadedAtMs:Date.now()-120_000,displays:oldDisplays},
      controlDiagnosticsCache:{loadedAtMs:Date.now()-120_000,diagnostics:oldControl},
      discoverDisplays: vi.fn(() => new Promise(resolve => setTimeout(() => {
        context.displayCache = {loadedAtMs:Date.now(),displays:newDisplays}; resolve(newDisplays);
      }, 300))),
      discoverControlDiagnostics: vi.fn(() => new Promise(resolve => setTimeout(() => {
        context.controlDiagnosticsCache = {loadedAtMs:Date.now(),diagnostics:newControl}; resolve(newControl);
      }, 900))),
      discoverMacAddresses: () => [], buildStreamDiagnostics: () => ({running:true}),
      readLocalZookNumber: vi.fn().mockResolvedValue("01234567"), getAgentConfigPath: () => "test-config",
      USE_FIREBASE:true, getDeviceAccessLock:vi.fn(),deviceAccessCapability:{accessPublicKey:"test-key"},
      API_BASE_URL:"", WONREMOTE_APP_VERSION:"0.1.1", CURRENT_REMOTE_PROTOCOL_VERSION:1,
      currentOutputIndex:0, AGENT_SYSTEM_INFO:{}, currentUpdateTelemetry:{state:"healthy"},
      sendAgentHeartbeat, agentHealthReporter:{heartbeatAccepted},
    };
    const sendHeartbeat = runInNewContext(compile(`${heartbeatRuntimeSource()}\nsendHeartbeat;`),context) as
      (value:typeof config, requestId?:string) => Promise<void>;
    const startup = sendHeartbeat(config);
    const first = sendHeartbeat(config,"nonce-1");
    await vi.advanceTimersByTimeAsync(149);
    expect(sendAgentHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendAgentHeartbeat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      heartbeatRequestId:"nonce-1",displays:oldDisplays,controlDiagnostics:oldControl,zookResult:{appliedNumber:"01234567"},
    }));
    await first;
    const second = sendHeartbeat(config,"nonce-2");
    await vi.advanceTimersByTimeAsync(150);
    await second;
    expect(sendAgentHeartbeat).toHaveBeenCalledTimes(2);
    expect(context.discoverDisplays).toHaveBeenCalledOnce();
    expect(context.discoverControlDiagnostics).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(600);
    await startup;
    expect(sendAgentHeartbeat).toHaveBeenLastCalledWith(expect.objectContaining({heartbeatRequestId:undefined,displays:newDisplays,controlDiagnostics:newControl}));
    await sendHeartbeat(config,"nonce-3");
    expect(sendAgentHeartbeat).toHaveBeenLastCalledWith(expect.objectContaining({heartbeatRequestId:"nonce-3",displays:newDisplays,controlDiagnostics:newControl}));
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(sendAgentHeartbeat).toHaveBeenCalledTimes(4);
    expect(heartbeatAccepted).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a real diagnostic child that does not return promptly", async () => {
    const helper = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "execFileHidden");
    const run = runInNewContext(compile(`${helper.getText(source)}\nexecFileHidden;`),{execFileAsync:promisify(execFile)});
    await expect(run(process.execPath,["-e","setTimeout(()=>{},600)"],60)).rejects.toMatchObject({killed:true});
  });

  it("does not turn a first display-probe timeout into a known empty inventory", async () => {
    const helper = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "discoverDisplays");
    const execFileHidden = vi.fn().mockRejectedValue(Object.assign(new Error("fixture timeout"),{killed:true}));
    const warn = vi.fn();
    const run = runInNewContext(compile(`${helper.getText(source)}\ndiscoverDisplays;`),{
      displayCache:null,execFileHidden,warnDiagnosticFailureOnce:warn,POC_PATH:"stub",
      DIAGNOSTICS_CACHE_AGE_MS:60_000,NATIVE_DIAGNOSTICS_TIMEOUT_MS:3_000,
    });
    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBeUndefined();
    expect(execFileHidden).toHaveBeenCalledExactlyOnceWith("stub",["--mode","list-displays"],3000);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("spends the remaining diagnostic budget even if the wall clock moves backward at launch", async () => {
    vi.useFakeTimers();
    let wall = 100_000, elapsed = 5;
    const pendingProbe = () => new Promise(resolve => setTimeout(() => resolve(undefined), 900));
    const diagnostics = runInNewContext(compile(`${heartbeatRuntimeSource()}\nreadHeartbeatDiagnostics("nonce");`), {
      Date:{now:()=>wall},performance:{now:()=>elapsed},setTimeout,clearTimeout,displayCache:null,controlDiagnosticsCache:null,
      discoverDisplays: () => { wall -= 60_000; elapsed += 20; return pendingProbe(); },
      discoverControlDiagnostics:pendingProbe,
    }) as Promise<unknown>;
    const done = vi.fn();
    void diagnostics.then(done);
    await vi.advanceTimersByTimeAsync(129);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledExactlyOnceWith([undefined,undefined]);
    await vi.advanceTimersByTimeAsync(770);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps live same-monitor capture and retains monitor-change and failed-capture recovery", async () => {
    const handler = findNode(node => ts.isPropertyAssignment(node) && node.name.getText(source) === "switchMonitor") as ts.PropertyAssignment;
    const context = {
      console: { log: vi.fn() }, deviceId: "device", activeSessionId: "session",
      currentOutputIndex: 0, currentLoopSleepMs: 16, streamDesired: true, streamRestartTimer: null as unknown,
      streamProcess: { killed: false, exitCode: null as number | null, signalCode: null as string | null } as any,
      startStreaming: vi.fn(async () => undefined),
    };
    const switchMonitor = runInNewContext(compile(`const handler = ${handler.initializer.getText(source)}; handler;`), context);
    await switchMonitor(0); await switchMonitor(0);
    expect(context.startStreaming).not.toHaveBeenCalled();
    await switchMonitor(1);
    expect(context.startStreaming).toHaveBeenLastCalledWith("device", "session", 1, 16);
    expect(context.currentOutputIndex).toBe(1);
    for (const process of [null, { killed: true, exitCode: null, signalCode: null }, { killed: false, exitCode: 1, signalCode: null }, { killed: false, exitCode: null, signalCode: "SIGTERM" }]) {
      context.streamProcess = process;
      context.startStreaming.mockClear();
      await switchMonitor(1);
      expect(context.startStreaming).toHaveBeenCalledOnce();
    }
    context.streamProcess = { killed: false, exitCode: null, signalCode: null };
    context.streamRestartTimer = 1;
    context.startStreaming.mockClear();
    await switchMonitor(1);
    expect(context.startStreaming).toHaveBeenCalledOnce();
    context.streamRestartTimer = null;
    context.streamDesired = false;
    context.startStreaming.mockClear();
    await switchMonitor(1);
    expect(context.startStreaming).toHaveBeenCalledOnce();
    context.activeSessionId = "";
    context.startStreaming.mockClear();
    await switchMonitor(2);
    expect(context.startStreaming).not.toHaveBeenCalled();
    expect(context.currentOutputIndex).toBe(2);
  });

  it.each([
    { code: undefined, earlyReconnect: true },
    { code: "permission-denied", earlyReconnect: false },
  ])("counts failed setup once and honors network return for $code", async ({ code, earlyReconnect }) => {
    vi.useFakeTimers();
    const listener = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === "startFirebaseCommandListener");
    const failure = Object.assign(new Error("offline"), { code });
    let networkAvailable = false;
    const subscribe = vi.fn()
      .mockImplementationOnce(async (_config, _commands, onError) => { onError(failure); throw failure; })
      .mockImplementationOnce(async (config) => { config.onReady(); return vi.fn(); });
    const context = {
      console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() }, process: { once: vi.fn() },
      setTimeout, clearTimeout, setInterval, clearInterval,
      networkInterfaces: () => ({ network: networkAvailable ? [{ internal: false }] : [] }),
      firebaseCommandRetryTimer: null, firebaseCommandUnsubscribe: null,
      firebaseCommandListenerRetryDelayMs, firebaseRequestRetryDelayMs, subscribeAgentCommandsWithFirebase: subscribe,
      agentHealthReporter: {
        takeCommandChallenge: () => null, commandReceiverUnavailable: vi.fn(),
        commandReceiverReady: vi.fn().mockResolvedValue(undefined),
      },
      executeReceivedCommands: vi.fn(), queueAgentHealthChallengeWithFirebase: vi.fn(),
    };
    runInNewContext(compile(`${listener.getText(source)}\nstartFirebaseCommandListener(() => ({ registeredDeviceId: "d", installId: "i" }));`), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(context.agentHealthReporter.commandReceiverUnavailable).toHaveBeenCalledOnce();
    expect(context.firebaseCommandRetryTimer).not.toBeNull();
    expect(vi.getTimerCount()).toBe(earlyReconnect ? 2 : 1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(subscribe).toHaveBeenCalledOnce();
    networkAvailable = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(subscribe).toHaveBeenCalledTimes(earlyReconnect ? 2 : 1);
    if (!earlyReconnect) {
      await vi.advanceTimersByTimeAsync(270_000);
      expect(subscribe).toHaveBeenCalledTimes(2);
    }
    expect(context.agentHealthReporter.commandReceiverReady).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the actual watch scheduler for 24h without a heartbeat, preserving update checks", async () => {
    vi.useFakeTimers();
    const watch = findNode((node) => ts.isIfStatement(node) && node.expression.getText(source) === 'process.argv.includes("--watch")'
      && node.thenStatement.getText(source).includes("startFirebaseCommandListener"));
    const heartbeat = vi.fn(); const checkUpdate = vi.fn().mockResolvedValue(undefined); const listen = vi.fn();
    runInNewContext(compile(`(async () => { ${watch.getText(source)} })();`), {
      process: { argv: ["--watch"] }, console, setInterval, activeConfig: {}, USE_FIREBASE: true,
      UPDATE_CHECK_INTERVAL_MS: 3_600_000, checkUpdate, startFirebaseCommandListener: listen,
      sendHeartbeat: heartbeat, sendHeartbeatWithRecovery: heartbeat, runAgentTick: heartbeat,
      agentHeartbeatGate: createAgentCommandPollGate(),
    });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledOnce();
    expect(checkUpdate).toHaveBeenCalledTimes(24);
  });

  it("executes exactly one heartbeat for a fresh refresh command, ignores expired requests and preserves input", async () => {
    const handler = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === "executeReceivedCommands");
    const heartbeat = vi.fn().mockResolvedValue({}); const input = vi.fn();
    const context = {
      console, Date, agentHeartbeatGate: createAgentCommandPollGate(), runAgentTick: heartbeat,
      agentCommandQueue: { enqueue: async (work: () => unknown) => work() },
      activeSessionId: "approved", USE_FIREBASE: true, readyDeviceAccessLock: {publicState:{enabled:false}},
      isStaleSessionInputCommand, executeAgentCommand: input, createAgentCommandRuntime: () => ({}),
      config: { registeredDeviceId: "d" }, commands: [
        { action: "refresh-status 00000000-0000-0000-0000-000000000001", createdAt: new Date().toISOString() },
        { action: "refresh-status 00000000-0000-0000-0000-000000000002", createdAt: "2020-01-01T00:00:00Z" },
        { action: "key-down A", createdAt: new Date().toISOString() },
      ],
    };
    await runInNewContext(compile(`${handler.getText(source)}\nexecuteReceivedCommands(config, commands);`), context);
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith(context.config, "00000000-0000-0000-0000-000000000001");
    expect(input).toHaveBeenCalledExactlyOnceWith("key-down A", "poll", {});
    context.readyDeviceAccessLock.publicState.enabled = true;
    context.commands = [
      {action:"key-down A",createdAt:new Date().toISOString()},
      {action:"key-down A",sessionId:"other",createdAt:new Date().toISOString()},
      {action:"key-down A",sessionId:"approved",createdAt:new Date().toISOString()},
    ] as typeof context.commands;
    input.mockClear();
    await runInNewContext(compile(`${handler.getText(source)}\nexecuteReceivedCommands(config, commands);`), context);
    expect(input).toHaveBeenCalledExactlyOnceWith("key-down A", "poll", {});
  });

  it("skips transient and unchanged telemetry but persists a real update failure once", async () => {
    const setter = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === "setUpdateTelemetry");
    const report = vi.fn().mockResolvedValue(undefined);
    const current = { currentVersion: "0.1.78", progress: 100, state: "healthy" as const, updatedAt: "2026-01-01T00:00:00Z" };
    await runInNewContext(compile(`${setter.getText(source)}
      setUpdateTelemetry(config, { progress: 0, state: "checking" }, false)
        .then(() => setUpdateTelemetry(config, { progress: 100, state: "healthy", targetVersion: undefined }))
        .then(() => setUpdateTelemetry(config, { error: "offline", state: "failed" }));`), {
      console, Date, config: { registeredDeviceId: "device" }, USE_FIREBASE: true,
      WONREMOTE_APP_VERSION: "0.1.78", currentUpdateTelemetry: current,
      lastReportedUpdateTelemetry: updateTelemetryStateKey(current),
      updateTelemetryStateKey, reportAgentUpdateTelemetryWithFirebase: report,
    });
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][1]).toMatchObject({ error: "offline", state: "failed" });
  });
});
