import type { AgentControlDiagnostics, AgentStreamDiagnostics } from "./types";

export function formatStreamDiagnostics(
  diagnostics: AgentStreamDiagnostics | undefined,
  transportState: string,
  frameCount: number,
  fallbackPollErrors: number,
): string[] {
  const lines = [`transport=${transportState}`, `frames=${frameCount}`];
  appendRealtimeTransportDiagnostics(lines, transportState);
  if (!diagnostics) {
    if (fallbackPollErrors > 0) {
      lines.push(`fallback-errors=${fallbackPollErrors}`);
    }
    return lines;
  }

  lines.push(`backend=${diagnostics.backend ?? "unknown"}`);
  lines.push(`stream=${diagnostics.running ? "running" : diagnostics.desired ? "recovering" : "stopped"}`);
  lines.push(`restart=${diagnostics.restartCount ?? 0}`);
  lines.push(`tile-path=${diagnostics.transport ?? "unknown"}`);
  if (diagnostics.rtcState && diagnostics.rtcState !== "none") {
    lines.push(`webrtc=${diagnostics.rtcState === "ready" ? "ready" : diagnostics.rtcState}`);
    if (diagnostics.rtcState === "unavailable") {
      lines.push("turn=check-required");
    }
  }
  if (diagnostics.rtcError) {
    lines.push(`webrtc-error=${diagnostics.rtcError}`);
  }
  if (diagnostics.loopSleepMs) {
    lines.push(`sleep=${diagnostics.loopSleepMs}ms`);
  }
  if (typeof diagnostics.outputIndex === "number") {
    lines.push(`display=#${diagnostics.outputIndex + 1}`);
  }
  if (diagnostics.lastFrameAt) {
    lines.push(`last-frame=${formatTimeLabel(diagnostics.lastFrameAt)}`);
  }
  if (diagnostics.lastError) {
    lines.push(`stream-error=${diagnostics.lastError}`);
  }
  if (fallbackPollErrors > 0) {
    lines.push(`fallback-errors=${fallbackPollErrors}`);
  }
  return lines;
}

function appendRealtimeTransportDiagnostics(lines: string[], transportState: string): void {
  if (transportState === "diagnostic-fallback-polling") {
    lines.push("viewer=diagnostic-fallback-polling");
  }
  if (
    transportState.startsWith("webrtc-unavailable") ||
    transportState.startsWith("webrtc-error") ||
    transportState.startsWith("webrtc-closed")
  ) {
    lines.push("webrtc=unavailable");
    lines.push("turn=check-required");
  }
}

export function formatControlDiagnostics(diagnostics: AgentControlDiagnostics | undefined): string[] {
  if (!diagnostics) {
    return ["control=unknown"];
  }

  const lines = [diagnostics.elevated ? "control=admin" : "control=user"];
  if (diagnostics.integrityLevel) {
    lines.push(`integrity=${diagnostics.integrityLevel}`);
  }
  if (typeof diagnostics.win32ErrorCode === "number" && diagnostics.win32ErrorCode !== 0) {
    lines.push(`win32=${diagnostics.win32ErrorCode}`);
  }
  if (diagnostics.win32ErrorMessage) {
    lines.push(`control-error=${diagnostics.win32ErrorMessage}`);
  }
  return lines;
}

export function shouldWarnAboutControlLimit(diagnostics: AgentControlDiagnostics | undefined): boolean {
  return Boolean(
    diagnostics &&
      (diagnostics.elevated === false ||
        (diagnostics.integrityLevel && !["High", "System"].includes(diagnostics.integrityLevel)) ||
        (typeof diagnostics.win32ErrorCode === "number" && diagnostics.win32ErrorCode !== 0)),
  );
}

function formatTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}
