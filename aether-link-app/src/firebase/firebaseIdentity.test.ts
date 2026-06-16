import { describe, expect, it } from "vitest";
import {
  buildAgentAuthEmail,
  buildAgentAuthPassword,
  buildAgentDeviceNumber,
  buildViewerAuthCredentials,
  buildFirebaseDeviceId,
  formatBusinessNumber,
  normalizeBusinessDigits,
} from "./firebaseIdentity";

describe("firebase identity helpers", () => {
  it("normalizes Korean business numbers to 10 digits", () => {
    expect(normalizeBusinessDigits("123-45-67890")).toBe("1234567890");
    expect(formatBusinessNumber("1234567890")).toBe("123-45-67890");
  });

  it("builds deterministic Firebase Auth email for agent accounts", () => {
    expect(buildAgentAuthEmail("123-45-67890")).toBe("1234567890@agents.wonremote.app");
    expect(buildAgentAuthPassword("123-45-67890", "1234")).toBe("wonremote-1234567890-1234");
  });

  it("maps Viewer business-number login to the same Firebase account as the Agent", () => {
    expect(buildViewerAuthCredentials("123-45-67890", "1234")).toEqual({
      email: "1234567890@agents.wonremote.app",
      password: "wonremote-1234567890-1234",
    });
  });

  it("keeps Viewer email login credentials unchanged", () => {
    expect(buildViewerAuthCredentials("owner@example.com", "secret123")).toEqual({
      email: "owner@example.com",
      password: "secret123",
    });
  });

  it("builds the same device identity shape used by the existing device table", () => {
    expect(buildAgentDeviceNumber("agent-localenv-425d1cbe")).toBe("AGENT-LOCALENV-425D1CB");
    expect(buildFirebaseDeviceId("1234567890", "agent-localenv-425d1cbe")).toBe(
      "123-45-67890:AGENT-LOCALENV-425D1CB",
    );
  });

  it("rejects invalid business numbers before Firebase calls", () => {
    expect(() => normalizeBusinessDigits("123")).toThrow("사업자등록번호는 숫자 10자리여야 합니다.");
  });

  it("rejects non-1234 agent passwords before Firebase calls", () => {
    expect(() => buildAgentAuthPassword("1234567890", "wrong")).toThrow("Agent password is invalid.");
  });

  it("rejects empty install identifiers with a readable Korean error", () => {
    expect(() => buildAgentDeviceNumber("agent-***")).toThrow("Agent 설치 식별자를 확인할 수 없습니다.");
  });
});
