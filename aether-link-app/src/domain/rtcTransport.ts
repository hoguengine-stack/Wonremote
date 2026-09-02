export interface WonRemoteIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export function viewerTileDataChannelOptions(): RTCDataChannelInit {
  return { ordered: false };
}

type RtcEnv = Partial<Record<string, string | undefined>>;

export interface WonRemoteRtcConfiguration {
  iceServers: WonRemoteIceServer[];
  iceTransportPolicy: "all" | "relay";
  source: "dynamic" | "static";
}

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

export function shouldUseDynamicTurnCredentials(env: RtcEnv): boolean {
  const value = firstEnv(
    env,
    "WONREMOTE_RTC_DYNAMIC_CREDENTIALS",
    "VITE_WONREMOTE_RTC_DYNAMIC_CREDENTIALS",
  );
  return value ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : false;
}

export async function resolveRtcConfiguration(
  env: RtcEnv,
  loadDynamic?: () => Promise<unknown>,
): Promise<WonRemoteRtcConfiguration> {
  const staticConfiguration: WonRemoteRtcConfiguration = {
    iceServers: resolveRtcIceServers(env),
    iceTransportPolicy: shouldUseRelayOnly(env) ? "relay" : "all",
    source: "static",
  };
  if (!shouldUseDynamicTurnCredentials(env)) {
    requireTurnWhenRelayOnly(env);
    return staticConfiguration;
  }
  if (!loadDynamic) {
    throw new Error("Dynamic TURN credentials are enabled but no credential provider is available.");
  }
  try {
    const dynamic = sanitizeDynamicRtcConfiguration(await loadDynamic());
    if (!dynamic.iceServers.some((server) => server.urls.some((url) => /^turns?:/i.test(url)))) {
      throw new Error("Dynamic RTC configuration did not include a TURN server.");
    }
    return dynamic;
  } catch (error) {
    const hasStaticTurn = staticConfiguration.iceServers.some((server) =>
      server.urls.some((url) => /^turns?:/i.test(url)),
    );
    if (hasStaticTurn) {
      return staticConfiguration;
    }
    throw error;
  }
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

function sanitizeDynamicRtcConfiguration(value: unknown): WonRemoteRtcConfiguration {
  const raw = value && typeof value === "object" && "data" in value
    ? (value as { data?: unknown }).data
    : value;
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawServers = Array.isArray(data.iceServers) ? data.iceServers : [];
  const iceServers = rawServers.flatMap((server): WonRemoteIceServer[] => {
    if (!server || typeof server !== "object") return [];
    const item = server as Record<string, unknown>;
    const urls = Array.isArray(item.urls)
      ? item.urls.map(String).map((url) => url.trim()).filter(Boolean)
      : typeof item.urls === "string" && item.urls.trim()
        ? [item.urls.trim()]
        : [];
    if (urls.length === 0) return [];
    return [{
      urls,
      ...(typeof item.username === "string" && item.username ? { username: item.username } : {}),
      ...(typeof item.credential === "string" && item.credential ? { credential: item.credential } : {}),
    }];
  });
  if (iceServers.length === 0) {
    throw new Error("Dynamic RTC configuration is empty.");
  }
  return {
    iceServers,
    iceTransportPolicy: data.iceTransportPolicy === "relay" ? "relay" : "all",
    source: "dynamic",
  };
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
