type RtcEnv = Partial<Record<string, string | undefined>>;

export const DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS = 12_000;
export const MIN_WEBRTC_CONNECT_TIMEOUT_MS = 2_000;
export const MAX_WEBRTC_CONNECT_TIMEOUT_MS = 120_000;

export function resolveWebRtcConnectTimeoutMs(env: RtcEnv): number {
  const raw = firstEnv(env, "WONREMOTE_RTC_CONNECT_TIMEOUT_MS", "VITE_WONREMOTE_RTC_CONNECT_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS;
  }

  return Math.min(MAX_WEBRTC_CONNECT_TIMEOUT_MS, Math.max(MIN_WEBRTC_CONNECT_TIMEOUT_MS, Math.trunc(parsed)));
}

export function isTerminalWebRtcConnectionState(state: string | undefined): boolean {
  return state === "failed" || state === "disconnected" || state === "closed";
}

export function formatWebRtcConnectionFailure(reason: string, detail?: string): string {
  const suffix = detail?.trim() ? `: ${detail.trim()}` : "";
  return `WebRTC realtime channel unavailable (${reason})${suffix}`;
}

function firstEnv(env: RtcEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
