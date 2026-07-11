import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_SYSTEM_COMMANDS,
  buildKeyboardCommand,
  buildMouseCommand,
  buildPasteTextCommand,
  buildSwitchMonitorCommand,
  buildSystemCommand,
  buildUnicodeTextCommand,
} from "../domain/remoteControlCommands";
import {
  createAgentCommandPollGate,
  createSerializedAgentCommandQueue,
  executeAgentCommand,
  isAllowedWebRtcAgentControlAction,
  isCurrentWebRtcSessionGeneration,
  type AgentCommandRuntime,
} from "./agentCommandExecution";

describe("Agent command execution", () => {
  it.each([
    "move 100 200",
    "mouse-down 100 200 left",
    "mouse-up 100 200 right",
    "mouse-wheel 100 200 -120",
    "key-down Ctrl",
    "key-up Ctrl",
    "keypress A",
    "key-release-all",
    "paste",
    "paste-text-base64 aGVsbG8=",
    "text-base64 7ZWc",
    "system taskmgr",
    "switch-monitor 2",
    "set-sleep 50",
    "clipboard-request",
    "ping-color-change",
  ])("allows WebRTC control action %s", (action) => {
    expect(isAllowedWebRtcAgentControlAction(action)).toBe(true);
  });

  it("allows every control command shape emitted by remoteControlCommands and App", () => {
    const emittedActions = [
      buildMouseCommand("move", 100, 200),
      buildMouseCommand("down", 100, 200, 0),
      buildMouseCommand("up", 100, 200, 2),
      buildMouseCommand("wheel", 100, 200, 0, -120),
      buildKeyboardCommand("keydown", "Control"),
      buildKeyboardCommand("keyup", "Control"),
      buildPasteTextCommand("clipboard text"),
      buildUnicodeTextCommand("A"),
      buildSwitchMonitorCommand(2),
      ...SUPPORTED_SYSTEM_COMMANDS.map((command) => buildSystemCommand(command)),
      "set-sleep 33",
      "key-release-all",
      "key-up Ctrl",
      "keypress Win",
      "keypress A",
      "paste",
      "ping-color-change",
      "clipboard-request",
    ];

    expect(emittedActions.every(isAllowedWebRtcAgentControlAction)).toBe(true);
  });

  it.each([
    "start-stream session-1",
    "stop-stream session-1",
    "request-approval",
    "security-code challenge-1 123 456",
    "wake-on-lan 00:11:22:33:44:55",
    "system format-c",
    "keypress",
    "keypress A B",
    "paste now",
    "move -1 100",
    "move 65536 100",
    "mouse-wheel 100 100 12001",
    "switch-monitor 32",
    "set-sleep 0",
    "set-sleep 1001",
    "unknown-command",
  ])("rejects WebRTC management or unknown action %s", async (action) => {
    const runtime = createRuntime();

    await expect(executeAgentCommand(action, "webrtc", runtime)).resolves.toBe("rejected");
    expect(runtime.injectAction).not.toHaveBeenCalled();
    expect(runtime.startStream).not.toHaveBeenCalled();
    expect(runtime.stopStream).not.toHaveBeenCalled();
    expect(runtime.requestApproval).not.toHaveBeenCalled();
    expect(runtime.sendWakeOnLan).not.toHaveBeenCalled();
    expect(runtime.showSecurityCode).not.toHaveBeenCalled();
  });

  it("ignores unsafe capture-control bounds even on the polled fallback", async () => {
    const runtime = createRuntime();

    await expect(executeAgentCommand("switch-monitor -1", "poll", runtime)).resolves.toBe("ignored");
    await expect(executeAgentCommand("switch-monitor 32", "poll", runtime)).resolves.toBe("ignored");
    await expect(executeAgentCommand("set-sleep 0", "poll", runtime)).resolves.toBe("ignored");
    await expect(executeAgentCommand("set-sleep 1001", "poll", runtime)).resolves.toBe("ignored");
    expect(runtime.switchMonitor).not.toHaveBeenCalled();
    expect(runtime.setSleep).not.toHaveBeenCalled();
  });

  it("uses the same injection callback for poll fallback and WebRTC controls", async () => {
    const runtime = createRuntime();

    await expect(executeAgentCommand("key-down A", "poll", runtime)).resolves.toBe("executed");
    await expect(executeAgentCommand("key-up A", "webrtc", runtime)).resolves.toBe("executed");
    await expect(executeAgentCommand("start-stream session-poll", "poll", runtime)).resolves.toBe("executed");

    expect(runtime.injectAction).toHaveBeenNthCalledWith(1, "key-down A");
    expect(runtime.injectAction).toHaveBeenNthCalledWith(2, "key-up A");
    expect(runtime.startStream).toHaveBeenCalledWith("session-poll");
  });

  it("keeps pressed-key state when key-up injection fails so shutdown can retry it", async () => {
    const runtime = createRuntime();
    runtime.pressedKeys.add("Ctrl");
    runtime.injectAction = vi.fn(async () => {
      throw new Error("input pipe failed");
    });

    await expect(executeAgentCommand("key-up Ctrl", "poll", runtime)).rejects.toThrow("input pipe failed");
    expect([...runtime.pressedKeys]).toEqual(["Ctrl"]);
  });

  it("does not track a key-down command that failed before acknowledgement", async () => {
    const runtime = createRuntime();
    runtime.injectAction = vi.fn(async () => {
      throw new Error("input rejected");
    });

    await expect(executeAgentCommand("key-down Ctrl", "poll", runtime)).rejects.toThrow("input rejected");
    expect([...runtime.pressedKeys]).toEqual([]);
  });

  it("serializes asynchronous key actions in enqueue order", async () => {
    const queue = createSerializedAgentCommandQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("key-down:start");
      await firstBlocked;
      order.push("key-down:end");
    });
    const second = queue.enqueue(async () => {
      order.push("key-up");
    });

    await Promise.resolve();
    expect(order).toEqual(["key-down:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["key-down:start", "key-down:end", "key-up"]);
  });

  it("drops a queued WebRTC control after its originating channel closes", async () => {
    const queue = createSerializedAgentCommandQueue();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let channelCurrent = true;
    const execute = vi.fn();

    const first = queue.enqueue(() => firstBlocked);
    const queuedControl = queue.enqueue(() => {
      if (
        !channelCurrent ||
        !isCurrentWebRtcSessionGeneration(4, 4, "session-1", "session-1")
      ) {
        return;
      }
      execute();
    });
    await Promise.resolve();
    channelCurrent = false;
    releaseFirst();
    await Promise.all([first, queuedControl]);

    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts controls only for the current WebRTC session generation", () => {
    expect(isCurrentWebRtcSessionGeneration(4, 4, "session-new", "session-new")).toBe(true);
    expect(isCurrentWebRtcSessionGeneration(3, 4, "session-new", "session-new")).toBe(false);
    expect(isCurrentWebRtcSessionGeneration(4, 4, "session-old", "session-new")).toBe(false);
  });

  it("does not inject the same polled command twice during concurrent ticks", async () => {
    const gate = createAgentCommandPollGate();
    const runtime = createRuntime();
    let releasePoll!: () => void;
    const pollBlocked = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });

    const firstTick = gate.run(async () => {
      await pollBlocked;
      await executeAgentCommand("key-down A", "poll", runtime);
    });
    const secondTick = await gate.run(async () => {
      await executeAgentCommand("key-down A", "poll", runtime);
    });

    expect(secondTick).toEqual({ started: false });
    releasePoll();
    await firstTick;
    expect(runtime.injectAction).toHaveBeenCalledTimes(1);
  });

  it("keeps command polling out of the heartbeat tick", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src", "agent", "index.ts"), "utf8");
    const heartbeatStart = source.indexOf("async function runAgentTick");
    const commandTickStart = source.indexOf("async function runCommandPollTick");
    const recoveryStart = source.indexOf("async function ensureActiveFirebaseSessionRecovery");
    const heartbeatBlock = source.slice(heartbeatStart, commandTickStart);
    const commandTickBlock = source.slice(commandTickStart, recoveryStart);

    expect(heartbeatStart).toBeGreaterThanOrEqual(0);
    expect(commandTickStart).toBeGreaterThan(heartbeatStart);
    expect(heartbeatBlock).not.toContain("pollCommands(");
    expect(commandTickBlock).toContain("pollCommands(config)");
    expect(commandTickBlock).toContain("agentCommandPollGate.run");
    expect(source.match(/await pollCommands\(/g)).toHaveLength(1);
    expect(source).toContain("activeConfig = await runCommandPollTick(activeConfig)");
  });

  it("routes interactive input through the persistent input server", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src", "agent", "index.ts"), "utf8");

    expect(source).toContain("persistentInputInjector.inject(action)");
    expect(source).toContain('persistentInputInjector.inject("ping-color-change")');
    expect(source).not.toContain('"inject-input"');
  });

  it("queues Firebase WebRTC controls behind the current generation guard", () => {
    const agentSource = readFileSync(path.resolve(process.cwd(), "src", "agent", "index.ts"), "utf8");
    const firebaseSource = readFileSync(path.resolve(process.cwd(), "src", "firebase", "agentFirebase.ts"), "utf8");
    const transportStart = agentSource.indexOf("void startAgentWebRtcTransportWithFirebase");
    const transportEnd = agentSource.indexOf(".then(async (transport)", transportStart);
    const transportBlock = agentSource.slice(transportStart, transportEnd);

    expect(transportStart).toBeGreaterThanOrEqual(0);
    expect(transportEnd).toBeGreaterThan(transportStart);
    expect(transportBlock).toContain("onControl: (action, isCurrentChannel)");
    expect(transportBlock).toContain("agentCommandQueue.enqueue");
    expect(transportBlock).toContain("isCurrentWebRtcSessionGeneration");
    expect(transportBlock).toContain("!isCurrentChannel()");
    expect(transportBlock).toContain('executeAgentCommand(action, "webrtc"');
    expect(transportBlock).toContain("onControlClosed: ()");
    expect(transportBlock).toContain("await releasePressedInput(");
    expect(transportBlock).toContain("onFileChunk: (chunk, isCurrentChannel)");
    expect(transportBlock).toContain("processWebRtcFileChunk(chunk");
    expect(firebaseSource).toContain("onControl?: (action: string, isCurrentChannel: () => boolean) => void");
    expect(firebaseSource).toContain("onControlClosed?: () => void");
    expect(firebaseSource).toContain("onFileChunk?: (");
    expect(firebaseSource).toContain("routeAgentDataChannel(event.channel");
    expect(firebaseSource).toContain("bindAgentControlMessages(channel");
    expect(firebaseSource).toContain("bindAgentFileMessages(channel");
  });

  it("keeps the session transport and persistent injector across same-session capture restarts", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src", "agent", "index.ts"), "utf8");
    const start = source.indexOf("async function startStreaming(");
    const end = source.indexOf("function ensureSessionWebRtcTransport(", start);
    const startBlock = source.slice(start, end);
    const ensureEnd = source.indexOf("function startSessionPolling(", end);
    const ensureBlock = source.slice(end, ensureEnd);

    expect(startBlock).toContain("const { sessionChanged } = generationTransition");
    expect(startBlock).toContain("if (sessionChanged && previousSessionId)");
    expect(startBlock).toContain("await releasePressedInputAndClose(");
    const transportCloseGuard = startBlock.lastIndexOf("if (sessionChanged)");
    const transportCloseBlock = startBlock.slice(transportCloseGuard);
    expect(transportCloseGuard).toBeGreaterThanOrEqual(0);
    expect(transportCloseBlock).toContain("const previousTransport = webRtcTransport");
    expect(startBlock).toContain("void previousTransport?.close()");
    expect(startBlock).toContain("ensureSessionWebRtcTransport(deviceId, sessionId, transportGeneration)");
    expect(startBlock).not.toContain("webRtcTransport.close()");
    expect(ensureBlock).toContain("webRtcTransport ||");
    expect(ensureBlock).toContain("webRtcTransportStartGeneration === expectedSessionGeneration");
  });
});

function createRuntime(): AgentCommandRuntime {
  return {
    deviceId: "device-1",
    firebaseEnabled: true,
    pressedKeys: new Set<string>(),
    getActiveSessionId: () => "session-1",
    injectAction: vi.fn(async () => undefined),
    requestApproval: vi.fn(async () => undefined),
    requestClipboard: vi.fn(async () => undefined),
    sendWakeOnLan: vi.fn(async () => undefined),
    setClipboardText: vi.fn(async () => undefined),
    setSleep: vi.fn(async () => undefined),
    showSecurityCode: vi.fn(async () => undefined),
    startStream: vi.fn(async () => undefined),
    stopStream: vi.fn(async () => undefined),
    switchMonitor: vi.fn(async () => undefined),
    triggerPingColorChange: vi.fn(async () => undefined),
    warn: vi.fn(),
  };
}
