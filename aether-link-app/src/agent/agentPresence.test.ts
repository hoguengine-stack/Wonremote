import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentCommandPollGate } from "./agentCommandExecution";
import { updateTelemetryStateKey } from "./agentUpdatePollPolicy";
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

describe("Windows Agent refresh-only heartbeat runtime", () => {
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
      isStaleSessionInputCommand: () => false, executeAgentCommand: input, createAgentCommandRuntime: () => ({}),
      config: { registeredDeviceId: "d" }, commands: [
        { action: "refresh-status 00000000-0000-0000-0000-000000000001", createdAt: new Date().toISOString() },
        { action: "refresh-status 00000000-0000-0000-0000-000000000002", createdAt: "2020-01-01T00:00:00Z" },
        { action: "key-down A", createdAt: new Date().toISOString() },
      ],
    };
    await runInNewContext(compile(`${handler.getText(source)}\nexecuteReceivedCommands(config, commands);`), context);
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith(context.config, "00000000-0000-0000-0000-000000000001");
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
