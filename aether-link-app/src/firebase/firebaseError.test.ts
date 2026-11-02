import { describe, expect, it } from "vitest";
import { explainFirebaseAuthError, isFirebaseAuthConfigurationError, throwExplainedFirebaseAuthError } from "./firebaseError";

describe("Firebase error handling", () => {
  it("preserves the rate-limit code without inventing a deadline or exposing provider details", () => {
    let error: any;
    try { throwExplainedFirebaseAuthError({code:"auth/too-many-requests",message:"private-provider-detail"}); }
    catch (caught) { error=caught; }
    expect(error.code).toBe("auth/too-many-requests");
    expect(error.message).toContain("이 기기의 로그인 요청이 일시 제한");
    expect(error.message).toContain("해제 시각이나 남은 시간을 제공하지 않아");
    expect(error.message).not.toMatch(/private-provider-detail|\d+\s*분|영구/);
  });
  it("detects Firebase Auth project/provider configuration failures", () => {
    expect(
      isFirebaseAuthConfigurationError({
        code: "auth/configuration-not-found",
      }),
    ).toBe(true);
    expect(
      isFirebaseAuthConfigurationError({
        message: "Firebase: Error (auth/configuration-not-found).",
      }),
    ).toBe(true);
  });

  it("explains that Auth must be enabled instead of exposing the raw Firebase error", () => {
    expect(explainFirebaseAuthError({ code: "auth/configuration-not-found" })).toContain(
      "Firebase Authentication",
    );
    expect(explainFirebaseAuthError({ code: "auth/configuration-not-found" })).toContain("Email/Password");
  });

  it("translates common Firebase Auth error codes to helpful Korean messages", () => {
    expect(explainFirebaseAuthError({ code: "auth/invalid-email" })).toContain(
      "올바른 이메일 형식이 아닙니다"
    );
    expect(explainFirebaseAuthError({ code: "auth/wrong-password" })).toContain(
      "이메일 주소 또는 비밀번호가 일치하지 않습니다"
    );
    expect(explainFirebaseAuthError({ code: "auth/too-many-requests" })).toContain(
      "로그인 시도가 너무 많아"
    );
  });
});
