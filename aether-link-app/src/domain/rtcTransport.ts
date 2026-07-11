export interface WonRemoteIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export function viewerTileDataChannelOptions(): RTCDataChannelInit {
  return { ordered: false };
}

type RtcEnv = Partial<Record<string, string | undefined>>;

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

export function resolveRtcIceServers(env: RtcEnv): WonRemoteIceServer[] {
  const stunUrls = parseCsv(firstEnv(env, "WONREMOTE_RTC_STUN_URLS", "VITE_WONREMOTE_RTC_STUN_URLS"));
  const turnUrls = parseCsv(firstEnv(env, "WONREMOTE_RTC_TURN_URLS", "VITE_WONREMOTE_RTC_TURN_URLS"));
  const servers: WonRemoteIceServer[] = [
    { urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS },
  ];

  if (turnUrls.length > 0) {
    const username = firstEnv(env, "WONREMOTE_RTC_TURN_USERNAME", "VITE_WONREMOTE_RTC_TURN_USERNAME");
    const credential = firstEnv(env, "WONREMOTE_RTC_TURN_CREDENTIAL", "VITE_WONREMOTE_RTC_TURN_CREDENTIAL");
    servers.push({
      urls: turnUrls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  return servers;
}

export function shouldUseRelayOnly(env: RtcEnv): boolean {
  const value = firstEnv(env, "WONREMOTE_RTC_RELAY_ONLY", "VITE_WONREMOTE_RTC_RELAY_ONLY");
  return value ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : false;
}

export function requireTurnWhenRelayOnly(env: RtcEnv): void {
  if (!shouldUseRelayOnly(env)) {
    return;
  }
  const turnUrls = parseCsv(firstEnv(env, "WONREMOTE_RTC_TURN_URLS", "VITE_WONREMOTE_RTC_TURN_URLS"));
  if (turnUrls.length === 0) {
    throw new Error("TURN relay-only mode requires WONREMOTE_RTC_TURN_URLS or VITE_WONREMOTE_RTC_TURN_URLS.");
  }
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

function parseCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
