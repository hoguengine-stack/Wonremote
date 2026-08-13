import { describe, expect, it } from "vitest";
import {
  encodeUpdateHandoffScriptPath,
  formatUpdateHandoffBrokerRequest,
  isUpdateHandoffBrokerEnabled,
  updateHandoffAcknowledgementPath,
  UPDATE_HANDOFF_BROKER_PREFIX,
} from "./agentUpdateHandoffBroker";

describe("agent update handoff broker", () => {
  it.each(["1", " 1 ", "TRUE", " yes "])('enables broker for %j', (value) => {
    expect(isUpdateHandoffBrokerEnabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "2"])('disables broker for %j', (value) => {
    expect(isUpdateHandoffBrokerEnabled(value)).toBe(false);
  });

  it("round-trips Unicode and whitespace paths through the strict request format", () => {
    const scriptPath = String.raw`C:\Users\테스트 사용자\WonRemote\업데이트 스크립트.ps1`;
    const request = formatUpdateHandoffBrokerRequest(scriptPath);

    expect(request).toBe(`${UPDATE_HANDOFF_BROKER_PREFIX}${encodeUpdateHandoffScriptPath(scriptPath)}`);
    expect(updateHandoffAcknowledgementPath(scriptPath)).toBe(`${scriptPath}.accepted`);
    expect(request).not.toContain(scriptPath);
    expect(Buffer.from(request.slice(UPDATE_HANDOFF_BROKER_PREFIX.length), "base64url").toString("utf8")).toBe(scriptPath);
  });
});
