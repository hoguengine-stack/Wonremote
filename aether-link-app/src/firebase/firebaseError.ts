const FIREBASE_AUTH_CONFIGURATION_CODES = new Set([
  "auth/configuration-not-found",
  "CONFIGURATION_NOT_FOUND",
]);

export function isFirebaseAuthConfigurationError(error: unknown): boolean {
  const code = readStringField(error, "code");
  if (code && FIREBASE_AUTH_CONFIGURATION_CODES.has(code)) {
    return true;
  }

  const message = readStringField(error, "message");
  return Boolean(
    message &&
      [...FIREBASE_AUTH_CONFIGURATION_CODES].some((token) =>
        message.toLowerCase().includes(token.toLowerCase()),
      ),
  );
}

export function explainFirebaseAuthError(error: unknown): string {
  if (isFirebaseAuthConfigurationError(error)) {
    return [
      "Firebase Authentication is not configured for this project.",
      "Enable Firebase Authentication and the Email/Password sign-in provider in the Firebase console, then try again.",
    ].join(" ");
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Firebase authentication failed.";
}

export function throwExplainedFirebaseAuthError(error: unknown): never {
  throw new Error(explainFirebaseAuthError(error));
}

function readStringField(error: unknown, key: "code" | "message"): string | undefined {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}
