import type { ManagedDevice } from "./types";

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const flag = (value: unknown) => typeof value === "boolean" ? value : null;
const choice = (value: unknown, allowed: readonly string[]) => typeof value === "string" && allowed.includes(value) ? value : null;
const version = (value: unknown) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function nativeDiagnosticExportUrl(report: string, userAgent: string): string | null {
  return /\bWonRemoteViewer\/1\b/.test(userAgent)
    ? `wonremote-diagnostics://save?report=${encodeURIComponent(report)}`
    : null;
}

// Export only typed diagnostics; free-form errors can contain credentials or paths.
export function createDiagnosticReport(device: ManagedDevice, viewerVersion: string) {
  const stream = device.streamDiagnostics;
  return {
    schemaVersion: 1,
    viewerVersion: version(viewerVersion),
    agentVersion: version(device.version),
    protocolVersion: number(device.protocolVersion),
    presence: choice(device.status, ["online", "offline"]),
    lastResponseAt: date(device.lastSeenAt),
    screen: {
      backend: choice(stream?.backend, ["dxgi", "gdi"]),
      running: flag(stream?.running),
      transport: choice(stream?.transport, ["webrtc", "firestore-fallback", "local-api", "none"]),
      connection: choice(stream?.rtcState, ["none", "starting", "ready", "unavailable"]),
      lastFrameAt: date(stream?.lastFrameAt),
      bufferedBytes: number(stream?.bufferedAmount),
      droppedFrames: number(stream?.droppedFrameCount),
      restartCount: number(stream?.restartCount),
      frameIntervalMs: number(stream?.loopSleepMs),
      hasCaptureError: Boolean(stream?.lastError),
      hasConnectionError: Boolean(stream?.rtcError),
    },
    windows: { elevated: flag(device.controlDiagnostics?.elevated), errorCode: number(device.controlDiagnostics?.win32ErrorCode) },
    update: {
      state: choice(device.updateState, ["idle", "checking", "downloading", "installing", "restarting", "healthy", "rollback", "failed"]),
      targetVersion: version(device.updateTargetVersion),
      hasError: Boolean(device.updateError),
    },
  };
}
