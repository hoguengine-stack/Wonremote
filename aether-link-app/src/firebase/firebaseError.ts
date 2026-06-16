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

  const code = readStringField(error, "code");
  if (code) {
    switch (code) {
      case "auth/invalid-email":
        return "올바른 이메일 형식이 아닙니다. Firebase 연동 모드에서는 이메일 주소를 계정명으로 사용해야 합니다.";
      case "auth/invalid-credential":
      case "auth/user-not-found":
      case "auth/wrong-password":
        return "이메일 주소 또는 비밀번호가 일치하지 않습니다.";
      case "auth/user-disabled":
        return "비활성화된 사용자 계정입니다.";
      case "auth/too-many-requests":
        return "로그인 시도가 너무 많아 일시적으로 계정이 차단되었습니다. 잠시 후 다시 시도해 주세요.";
    }
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
