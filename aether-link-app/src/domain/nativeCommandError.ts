export function nativeCommandErrorMessage(error: unknown, fallback: string): string {
  // Tauri Result<_, String> rejects with a string, not a JavaScript Error.
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.trim() || fallback;
}
