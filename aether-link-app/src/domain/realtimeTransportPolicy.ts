export function shouldPollViewerTileFallback(input: {
  firebaseEnabled: boolean;
  env: Partial<Record<string, string | boolean | undefined>>;
}): boolean {
  if (!input.firebaseEnabled) {
    return true;
  }
  const value =
    readEnvString(input.env, "VITE_WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK") ??
    readEnvString(input.env, "WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK");
  return value?.trim().toLowerCase() === "diagnostic";
}

function readEnvString(env: Partial<Record<string, string | boolean | undefined>>, key: string): string | undefined {
  const value = env[key];
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return typeof value === "string" ? value : undefined;
}
