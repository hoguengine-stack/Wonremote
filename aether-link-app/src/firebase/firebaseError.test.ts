import { describe, expect, it } from "vitest";
import { explainFirebaseAuthError, isFirebaseAuthConfigurationError } from "./firebaseError";

describe("Firebase error handling", () => {
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
});
