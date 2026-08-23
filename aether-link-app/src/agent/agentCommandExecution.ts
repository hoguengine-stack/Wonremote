import { SUPPORTED_SYSTEM_COMMANDS } from "../domain/remoteControlCommands";
import {
  parseSecurityCodeCommand,
  recordPendingInjectAction,
  recordSuccessfulInjectAction,
  resolveInjectActions,
} from "./agentCommandActions";
import {
  currentSessionId,
  sessionIdFromStartStreamCommand,
  shouldStopActiveSession,
  stopStreamTargetFromCommand,
} from "./agentSessionLifecycle";
import { parseWakeOnLanCommand } from "./wakeOnLan";
import { parseSetStreamModeCommand } from "../domain/streamPerformanceMode";

type MaybePromise<T = void> = T | Promise<T>;

export type AgentCommandSource = "poll" | "webrtc";
export type AgentCommandExecutionResult = "executed" | "ignored" | "rejected";
export const MAX_AGENT_MONITOR_INDEX = 31;
export const MIN_AGENT_STREAM_SLEEP_MS = 1;
export const MAX_AGENT_STREAM_SLEEP_MS = 1_000;
const MIN_ABSOLUTE_POINTER_COORDINATE = 0;
const MAX_ABSOLUTE_POINTER_COORDINATE = 65_535;
const MAX_ABSOLUTE_WHEEL_DELTA = 12_000;

export interface AgentCommandRuntime {
  deviceId: string;
  firebaseEnabled: boolean;
  pressedKeys: Set<string>;
  getActiveSessionId: () => string | null;
  injectAction: (action: string) => MaybePromise;
  requestApproval: () => MaybePromise;
  requestClipboard: (sessionId: string) => MaybePromise;
  sendWakeOnLan: (macAddress: string) => MaybePromise;
  setClipboardText: (text: string) => MaybePromise;
  setSleep: (milliseconds: number) => MaybePromise;
  setStreamMode: (mode: "fast" | "normal") => MaybePromise;
  showSecurityCode: (code: string) => MaybePromise;
  startStream: (sessionId: string) => MaybePromise;
  stopStream: () => MaybePromise;
  switchMonitor: (outputIndex: number) => MaybePromise;
  triggerPingColorChange: () => MaybePromise;
  warn?: (message: string) => void;
}

export interface SerializedAgentCommandQueue {
  enqueue<T>(task: () => Promise<T> | T): Promise<T>;
}

export type SingleFlightResult<T> =
  | { started: false }
  | { started: true; value: T };

export interface AgentCommandPollGate {
  run<T>(task: () => Promise<T>): Promise<SingleFlightResult<T>>;
}

export async function executeAgentCommand(
  action: string,
  source: AgentCommandSource,
  runtime: AgentCommandRuntime,
): Promise<AgentCommandExecutionResult> {
  const normalizedAction = action.trim();
  if (source === "webrtc" && !isAllowedWebRtcAgentControlAction(normalizedAction)) {
    runtime.warn?.(`[WebRTC] Rejected non-control Agent command: ${normalizedAction || "<empty>"}`);
    return "rejected";
  }

  if (normalizedAction === "request-approval") {
    await runtime.requestApproval();
    return "executed";
  }

  if (normalizedAction.startsWith("start-stream")) {
    const sessionId = sessionIdFromStartStreamCommand(normalizedAction, {
      deviceId: runtime.deviceId,
      firebaseEnabled: runtime.firebaseEnabled,
    });
    if (!sessionId) {
      runtime.warn?.("Ignoring Firebase start-stream command without a sessionId.");
      return "ignored";
    }
    await runtime.startStream(sessionId);
    return "executed";
  }

  if (normalizedAction.startsWith("stop-stream")) {
    const requestedSessionId = stopStreamTargetFromCommand(normalizedAction);
    const activeSessionId = runtime.getActiveSessionId();
    if (
      requestedSessionId === null ||
      !shouldStopActiveSession(activeSessionId, requestedSessionId, runtime.firebaseEnabled)
    ) {
      runtime.warn?.(
        `Ignoring stop-stream for non-active session ${requestedSessionId ?? "<legacy>"}; active session is ${activeSessionId ?? "none"}.`,
      );
      return "ignored";
    }
    await runtime.stopStream();
    return "executed";
  }

  const monitorMatch = /^switch-monitor\s+(-?\d+)$/.exec(normalizedAction);
  if (normalizedAction === "switch-monitor" || normalizedAction.startsWith("switch-monitor ")) {
    const outputIndex = boundedIntegerMatch(monitorMatch, 1, 0, MAX_AGENT_MONITOR_INDEX);
    if (outputIndex === null) {
      runtime.warn?.(`Ignoring invalid switch-monitor command: ${normalizedAction}`);
      return "ignored";
    }
    await runtime.switchMonitor(outputIndex);
    return "executed";
  }

  const sleepMatch = /^set-sleep\s+(-?\d+)$/.exec(normalizedAction);
  if (normalizedAction === "set-sleep" || normalizedAction.startsWith("set-sleep ")) {
    const milliseconds = boundedIntegerMatch(
      sleepMatch,
      1,
      MIN_AGENT_STREAM_SLEEP_MS,
      MAX_AGENT_STREAM_SLEEP_MS,
    );
    if (milliseconds === null) {
      runtime.warn?.(`Ignoring invalid set-sleep command: ${normalizedAction}`);
      return "ignored";
    }
    await runtime.setSleep(milliseconds);
    return "executed";
  }

  if (normalizedAction === "set-stream-mode" || normalizedAction.startsWith("set-stream-mode ")) {
    const mode = parseSetStreamModeCommand(normalizedAction);
    if (!mode) {
      runtime.warn?.(`Ignoring invalid set-stream-mode command: ${normalizedAction}`);
      return "ignored";
    }
    await runtime.setStreamMode(mode);
    return "executed";
  }

  if (normalizedAction === "clipboard-request") {
    const sessionId = currentSessionId(runtime.getActiveSessionId(), {
      deviceId: runtime.deviceId,
      firebaseEnabled: runtime.firebaseEnabled,
    });
    if (!sessionId) {
      runtime.warn?.("Ignoring clipboard-request because no active Firebase session exists.");
      return "ignored";
    }
    await runtime.requestClipboard(sessionId);
    return "executed";
  }

  if (normalizedAction.startsWith("wake-on-lan")) {
    const targetMac = parseWakeOnLanCommand(normalizedAction);
    if (!targetMac) {
      runtime.warn?.(`[Wake-on-LAN] Ignoring invalid command: ${normalizedAction}`);
      return "ignored";
    }
    await runtime.sendWakeOnLan(targetMac);
    return "executed";
  }

  if (normalizedAction === "security-code" || normalizedAction.startsWith("security-code ")) {
    const securityCode = parseSecurityCodeCommand(normalizedAction);
    if (!securityCode) {
      runtime.warn?.(`[Security Connect] Invalid security-code command: ${normalizedAction}`);
      return "ignored";
    }
    await runtime.showSecurityCode(securityCode.code);
    return "executed";
  }

  if (normalizedAction === "ping-color-change") {
    await runtime.triggerPingColorChange();
    return "executed";
  }

  const resolved = resolveInjectActions(normalizedAction, runtime.pressedKeys);
  if (resolved.type === "pasteText") {
    await runtime.setClipboardText(resolved.text);
  }
  for (const resolvedAction of resolved.actions) {
    recordPendingInjectAction(resolvedAction, runtime.pressedKeys);
    await runtime.injectAction(resolvedAction);
    recordSuccessfulInjectAction(resolvedAction, runtime.pressedKeys);
  }
  return "executed";
}

export function isAllowedWebRtcAgentControlAction(action: string): boolean {
  const normalized = action.trim();
  if (normalized === "clipboard-request" || normalized === "ping-color-change") {
    return true;
  }
  if (normalized === "key-release-all" || normalized === "key_release_all") {
    return true;
  }
  if (normalized === "paste" || /^(key-down|key-up|keypress)\s+\S+$/.test(normalized)) {
    return true;
  }
  const moveMatch = /^move\s+(-?\d+)\s+(-?\d+)$/.exec(normalized);
  if (moveMatch) {
    return hasValidPointerCoordinates(moveMatch, 1, 2);
  }
  const buttonMatch = /^mouse-(down|up)\s+(-?\d+)\s+(-?\d+)\s+(left|middle|right)$/.exec(normalized);
  if (buttonMatch) {
    return hasValidPointerCoordinates(buttonMatch, 2, 3);
  }
  const wheelMatch = /^mouse-wheel\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/.exec(normalized);
  if (wheelMatch) {
    return hasValidPointerCoordinates(wheelMatch, 1, 2) &&
      boundedIntegerMatch(wheelMatch, 3, -MAX_ABSOLUTE_WHEEL_DELTA, MAX_ABSOLUTE_WHEEL_DELTA) !== null;
  }
  if (/^(paste-text-base64|paste_text|paste-text|text-base64)\s+\S+$/.test(normalized)) {
    return true;
  }
  const replaceTextMatch = /^text-replace-base64\s+(\d+)\s+(\S+)$/.exec(normalized);
  if (replaceTextMatch) {
    return boundedIntegerMatch(replaceTextMatch, 1, 0, 4096) !== null;
  }
  const monitorMatch = /^switch-monitor\s+(\d+)$/.exec(normalized);
  if (monitorMatch) {
    return boundedIntegerMatch(monitorMatch, 1, 0, MAX_AGENT_MONITOR_INDEX) !== null;
  }
  const sleepMatch = /^set-sleep\s+(\d+)$/.exec(normalized);
  if (sleepMatch) {
    return boundedIntegerMatch(
      sleepMatch,
      1,
      MIN_AGENT_STREAM_SLEEP_MS,
      MAX_AGENT_STREAM_SLEEP_MS,
    ) !== null;
  }
  const streamMode = parseSetStreamModeCommand(normalized);
  if (streamMode) {
    return true;
  }
  const systemMatch = /^system\s+(.+)$/.exec(normalized);
  return Boolean(
    systemMatch &&
    SUPPORTED_SYSTEM_COMMANDS.includes(systemMatch[1] as (typeof SUPPORTED_SYSTEM_COMMANDS)[number]),
  );
}

function hasValidPointerCoordinates(match: RegExpExecArray, dxIndex: number, dyIndex: number): boolean {
  return boundedIntegerMatch(
    match,
    dxIndex,
    MIN_ABSOLUTE_POINTER_COORDINATE,
    MAX_ABSOLUTE_POINTER_COORDINATE,
  ) !== null && boundedIntegerMatch(
    match,
    dyIndex,
    MIN_ABSOLUTE_POINTER_COORDINATE,
    MAX_ABSOLUTE_POINTER_COORDINATE,
  ) !== null;
}

function boundedIntegerMatch(
  match: RegExpExecArray | null,
  index: number,
  minimum: number,
  maximum: number,
): number | null {
  if (!match) {
    return null;
  }
  const value = Number(match[index]);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

export function isCurrentWebRtcSessionGeneration(
  expectedGeneration: number,
  currentGeneration: number,
  expectedSessionId: string,
  activeSessionId: string | null,
): boolean {
  return expectedGeneration === currentGeneration && expectedSessionId === activeSessionId;
}

export const isCurrentWebRtcControlGeneration = isCurrentWebRtcSessionGeneration;

export function createSerializedAgentCommandQueue(): SerializedAgentCommandQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T> | T): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

export function createAgentCommandPollGate(): AgentCommandPollGate {
  let inFlight = false;
  return {
    async run<T>(task: () => Promise<T>): Promise<SingleFlightResult<T>> {
      if (inFlight) {
        return { started: false };
      }
      inFlight = true;
      try {
        return { started: true, value: await task() };
      } finally {
        inFlight = false;
      }
    },
  };
}
