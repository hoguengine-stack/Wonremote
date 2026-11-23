import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentCommandPollGate } from "./agentCommandExecution";
import { createRemoteUpdateRequest } from "./remoteUpdateRequest";
import { isStaleSessionInputCommand } from "./agentSessionLifecycle";
import { updateTelemetryStateKey } from "./agentUpdatePollPolicy";
import { decideUpdateEligibility } from "../domain/updateFleetPolicy";
import { firebaseCommandListenerRetryDelayMs, firebaseRequestRetryDelayMs } from "../firebase/requestRetryPolicy";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!result && predicate(node)) result = node; else ts.forEachChild(node, visit); };
  visit(source);
  if (!result) throw new Error("Agent lifecycle block missing");
  return result;
}
const compile = (text: string) => ts.transpile(text, { target: ts.ScriptTarget.ES2022 });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("installed Agent selected update handoff", () => {
  it.each(["authorized", "selection withdrawn", "device paused", "busy", "policy unavailable", "selected version changed"])(
    "never launches a selected update outside the active policy: %s", async scenario => {
      const sourceCheck = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "checkUpdate");
      const rollout = { targetVersion: "0.1.126", stage: "general", percentage: 0, targetDeviceIds: ["chosen"] };
      const initial = { rollout, updatePaused: false, updateRing: "general" };
      const fresh = scenario === "selection withdrawn" ? { ...initial, rollout: { ...rollout, targetDeviceIds: ["other"] } }
        : scenario === "selected version changed" ? { ...initial, rollout: { ...rollout, targetVersion: "0.1.127" } }
        : scenario === "device paused" ? { ...initial, updatePaused: true } : initial;
      const loadPolicy = vi.fn(async () => {
        if (scenario === "policy unavailable") throw new Error("offline");
        return rollout;
      });
      const metadata = vi.fn(async () => ({ selected: true, metadata: { latestVersion: "0.1.126" } }));
      const loadRollout = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
      const startInstaller = vi.fn();
      const handoff = vi.fn(async (_data, _config, _retry, beforeLaunch: () => Promise<void>) => {
        await beforeLaunch();
        startInstaller();
      });
      const context = { USE_FIREBASE: true, process: { platform: "win32", env: { WONREMOTE_PACKAGE_KIND: "installer" } }, isUpdateHandoffBrokerEnabled: () => true,
        agentHealthReporter: { isHealthy: () => true }, isUpdating: false, queuedViewerUpdate: undefined, lastUpdateCheckAttemptAtMs: null,
        UPDATE_CHECK_INTERVAL_MS: 3_600_000, WONREMOTE_APP_VERSION: "0.1.124", currentUpdateTelemetry: { state: "idle" },
        shouldAttemptAgentUpdateCheck: () => true, setUpdateTelemetry: vi.fn(), scheduleAgentUpdateRetry: vi.fn(),
        loadAgentUpdateRolloutPolicyWithFirebase: loadPolicy, loadProductionAgentUpdateCandidate: metadata,
        loadAgentUpdateRolloutWithFirebase: loadRollout, isHigherVersion: (latest: string) => latest === "0.1.126",
        activeSessionId: scenario === "busy" ? "fallback-session" : null, rtcState: "unavailable", stopSessionPolling: vi.fn(), remoteUpdateRequest: { defer: vi.fn() },
        selectedUpdateHandoffClaimed: false, shouldDeferAgentUpdateForSession: () => false,
        prepareAgentUpdateSession: async () => "ready", decideUpdateEligibility,
        isPortableUpdateMetadata: () => false, isInstallerUpdateMetadata: () => true,
        handoffToProductionInstallerUpdate: handoff, console: { log: vi.fn(), error: vi.fn() },
      };
      const run = runInNewContext(compile(`${sourceCheck.getText(source)}\ncheckUpdate;`), context);
      await Promise.all([run({ registeredDeviceId: "chosen" }), run({ registeredDeviceId: "chosen" })]);
      expect(loadPolicy).toHaveBeenCalledTimes(1);
      expect(metadata).toHaveBeenCalledTimes(scenario === "policy unavailable" ? 0 : 1);
      if (scenario === "busy" || scenario === "policy unavailable") {
        expect(loadRollout).not.toHaveBeenCalled();
        expect(handoff).not.toHaveBeenCalled();
        expect(context.remoteUpdateRequest.defer).toHaveBeenCalledTimes(scenario === "busy" ? 1 : 0);
      } else {
        expect(loadRollout.mock.calls).toEqual([
          ["chosen", context.process.env, { selected: true }],
          ["chosen", context.process.env, { selected: true, requireServer: true }],
        ]);
        expect(handoff).toHaveBeenCalledTimes(1);
      }
      expect(startInstaller).toHaveBeenCalledTimes(scenario === "authorized" ? 1 : 0);
    },
  );

  it.each(["no rollout", "paused rollout", "excluded", "selection withdrawn", "busy", "queued", "no broker"])(
    "honors a Viewer update request while protecting its target and session: %s", async scenario => {
      const sourceCheck = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "checkUpdate");
      const rollout = { targetVersion: "0.1.125", stage: "general", paused: true, targetDeviceIds: ["chosen"] };
      const loadPolicy = vi.fn().mockResolvedValue(scenario === "no rollout" ? null : rollout);
      if (scenario === "excluded") loadPolicy.mockResolvedValue({ ...rollout, targetDeviceIds: [] });
      if (scenario === "selection withdrawn") loadPolicy.mockResolvedValueOnce(rollout).mockResolvedValueOnce(null);
      const data = { latestVersion: "0.1.125" };
      const loadManual = vi.fn(async () => data);
      const launch = vi.fn();
      const handoff = vi.fn(async (_data, _config, _retry, guard: () => Promise<void>) => {
        await guard();
        launch();
      });
      const requestId = "1795406892849";
      let finishAuto!: () => void;
      const autoWaiting = new Promise<void>(resolve => { finishAuto = resolve; });
      const telemetry = vi.fn(async (_config, patch) => {
        if (scenario === "queued" && patch.error === "Update metadata is unavailable.") await autoWaiting;
      });
      const remoteGate = createRemoteUpdateRequest(() => scenario === "busy");
      const context = {
        USE_FIREBASE: true, process: { platform: "win32", env: { WONREMOTE_PACKAGE_KIND: "installer" } }, isUpdateHandoffBrokerEnabled: () => scenario !== "no broker",
        isUpdating: false, queuedViewerUpdate: undefined, queueMicrotask,
        agentHealthReporter: { isHealthy: () => true }, shouldAttemptAgentUpdateCheck: () => true, UPDATE_CHECK_INTERVAL_MS: 3_600_000,
        lastUpdateCheckAttemptAtMs: null, WONREMOTE_APP_VERSION: "0.1.124",
        currentUpdateTelemetry: { state: "failed", targetVersion: "0.1.125" },
        activeSessionId: scenario === "busy" ? "session" : null, loadAgentUpdateRolloutPolicyWithFirebase: loadPolicy,
        loadProductionAgentUpdateCandidate: vi.fn(async () => ({ metadata: null, selected: false })),
        loadViewerRequestedAgentUpdate: loadManual, isInstallerUpdateMetadata: () => true,
        remoteUpdateRequest: { ...remoteGate, defer: vi.fn(remoteGate.defer) },
        handoffToProductionInstallerUpdate: handoff, setUpdateTelemetry: telemetry, scheduleAgentUpdateRetry: vi.fn(),
        selectedUpdateHandoffClaimed: false, console: { error: vi.fn() },
      };
      const run = runInNewContext(compile(`${sourceCheck.getText(source)}\ncheckUpdate;`), context);
      const device = { registeredDeviceId: "chosen" };
      if (scenario === "queued") {
        const auto = run(device);
        await vi.waitFor(() => expect(telemetry).toHaveBeenCalledWith(device, expect.objectContaining({ error: "Update metadata is unavailable." })));
        finishAuto();
        const accepted = context.remoteUpdateRequest.receive(`request-update ${requestId}`, () => run(device, true, requestId), Number(requestId));
        expect(loadManual).not.toHaveBeenCalled();
        await auto;
        expect(await accepted).toBe(true);
        await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      } else {
        await run(device, true, requestId);
      }
      if (scenario === "busy") {
        expect(loadManual).not.toHaveBeenCalled();
        expect(context.remoteUpdateRequest.defer).toHaveBeenCalledOnce();
      } else if (scenario === "no broker") {
        expect(loadManual).not.toHaveBeenCalled();
        expect(context.setUpdateTelemetry).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "failed" }));
      } else {
        expect(loadManual).toHaveBeenCalledWith("0.1.124");
        expect(context.currentUpdateTelemetry).toMatchObject({ requestId: "1795406892849" });
      }
      expect(launch).toHaveBeenCalledTimes(["no rollout", "paused rollout", "queued"].includes(scenario) ? 1 : 0);
      if (scenario === "excluded" || scenario === "selection withdrawn") {
        expect(context.setUpdateTelemetry).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: "failed" }));
      }
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

  it("keeps a session from becoming authorized when a selected update claims the handoff during its lock check", async () => {
    const node = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "startStreaming");
    const previous = { id: "old-session", version: 1 };
    const context = { USE_FIREBASE: true, process: { platform: "win32" }, activeSessionId: null,
      authorizedAccessSession: previous, readyDeviceAccessLock: { publicState: { version: 2 } },
      selectedUpdateHandoffClaimed: false, shouldCheckDeviceAccessSession: () => true,
      getDeviceAccessLock: async () => ({}),
      isAgentDeviceAccessSessionAllowed: async () => {
        context.selectedUpdateHandoffClaimed = true;
        return true;
      },
    };
    const start = runInNewContext(compile(node.getText(source) + "\nstartStreaming;"), context);
    await expect(start("chosen", "new-session", 0, 100, "dxgi")).rejects.toThrow("Selected Agent update handoff is in progress.");
    expect(context.authorizedAccessSession).toBe(previous);
  });

  it("uses only server snapshots for selected discovery and pre-launch revalidation", async () => {
    const firebase = ts.createSourceFile("agentFirebase.ts", readFileSync(new URL("../firebase/agentFirebase.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const helpers = firebase.statements.filter(ts.isFunctionDeclaration).filter(node =>
      node.name?.text === "loadAgentUpdateRolloutPolicyWithFirebase" || node.name?.text === "loadAgentUpdateRolloutWithFirebase"
    );
    const rollout = { targetVersion: "0.1.125", targetDeviceIds: ["chosen"], stage: "general", percentage: 0 };
    const server = vi.fn(async (path: string) => ({
      exists: () => true,
      data: () => path === "devices/chosen" ? { updatePaused: true } : rollout,
    }));
    const cached = vi.fn();
    const context = { process: { env: {} }, getAgentFirebaseServices: () => ({ db: {} }),
      doc: (_db: unknown, collection: string, id: string) => collection + "/" + id,
      getDoc: cached, getDocFromServer: server,
      readUpdateRollout: (data: unknown, selected: boolean) => selected ? data : null, sanitizeUpdateRing: () => "general",
    };
    const [readPolicy, readForLaunch] = runInNewContext(compile(helpers.map(node => node.getText(firebase).replace("export ", "")).join("\n")
      + "\n[loadAgentUpdateRolloutPolicyWithFirebase, loadAgentUpdateRolloutWithFirebase];"), context);
    await expect(readPolicy()).resolves.toEqual(rollout);
    await expect(readForLaunch("chosen", {}, { selected: true, requireServer: true })).resolves.toMatchObject({ rollout, updatePaused: true });
    expect(server.mock.calls).toEqual([["configuration/updateRollout"], ["devices/chosen"], ["configuration/updateRollout"]]);
    expect(cached).not.toHaveBeenCalled();
    server.mockRejectedValueOnce(new Error("offline"));
    await expect(readForLaunch("chosen", {}, { selected: true, requireServer: true })).rejects.toThrow("offline");
    expect(cached).not.toHaveBeenCalled();
  });
});

describe("Windows Agent refresh-only heartbeat runtime", () => {
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
