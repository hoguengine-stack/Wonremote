export type ResolvedAgentAction =
  | { type: "inject"; actions: string[] }
  | { type: "pasteText"; text: string; actions: string[] };

export function resolveInjectActions(action: string, pressedKeys: Set<string>): ResolvedAgentAction {
  const trimmed = action.trim();
  if (trimmed.startsWith("key-down ")) {
    return { type: "inject", actions: [trimmed] };
  }

  if (trimmed.startsWith("key-up ")) {
    return { type: "inject", actions: [trimmed] };
  }

  if (trimmed === "key-release-all" || trimmed === "key_release_all") {
    const actions = [...pressedKeys].reverse().map((key) => `key-up ${key}`);
    return { type: "inject", actions };
  }

  if (trimmed === "paste") {
    return { type: "inject", actions: [pressedKeys.has("Ctrl") ? "keypress V" : "paste"] };
  }

  const pastePayloadPrefix = ["paste-text-base64 ", "paste_text ", "paste-text "].find((prefix) =>
    trimmed.startsWith(prefix),
  );
  if (pastePayloadPrefix) {
    const payload = trimmed.slice(pastePayloadPrefix.length).trim();
    return {
      type: "pasteText",
      text: decodeUtf8Base64(payload),
      actions: [pressedKeys.has("Ctrl") ? "keypress V" : "paste"],
    };
  }

  return { type: "inject", actions: [trimmed] };
}

export function recordPendingInjectAction(action: string, pressedKeys: Set<string>): void {
  const trimmed = action.trim();
  if (!trimmed.startsWith("key-down ")) {
    return;
  }
  const key = trimmed.slice("key-down ".length).trim();
  if (key) {
    pressedKeys.add(key);
  }
}

export function recordSuccessfulInjectAction(action: string, pressedKeys: Set<string>): void {
  const trimmed = action.trim();
  if (trimmed.startsWith("key-down ")) {
    const key = trimmed.slice("key-down ".length).trim();
    if (key) {
      pressedKeys.add(key);
    }
    return;
  }
  if (trimmed.startsWith("key-up ")) {
    const key = trimmed.slice("key-up ".length).trim();
    if (key) {
      pressedKeys.delete(key);
    }
  }
}

export function parseSecurityCodeCommand(action: string): { challengeId: string; code: string } | null {
  const match = action.trim().match(/^security-code\s+(\S+)\s+(\d{3}\s\d{3})$/);
  if (!match) {
    return null;
  }

  return {
    challengeId: match[1],
    code: match[2],
  };
}

function decodeUtf8Base64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
