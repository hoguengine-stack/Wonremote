import { describe, expect, it } from "vitest";
import {
  AGENT_UPDATE_HANDOFF_EXIT_CODE,
  encodeUpdateHandoffScriptPath,
  formatInstallerUpdateHandoffBrokerRequest,
  formatUpdateHandoffBrokerRequest,
  INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX,
  isUpdateHandoffBrokerEnabled,
  UPDATE_HANDOFF_ACKNOWLEDGEMENT_TIMEOUT_MS,
  updateHandoffAcknowledgementPath,
  UPDATE_HANDOFF_BROKER_PREFIX,
} from "./agentUpdateHandoffBroker";

describe("agent update handoff broker", () => {
  it("reserves a dedicated successful handoff exit code", () => {
    expect(AGENT_UPDATE_HANDOFF_EXIT_CODE).toBe(42);
    expect(AGENT_UPDATE_HANDOFF_EXIT_CODE).not.toBe(0);
  });

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

  it("pins installer handoff paths and hashes in the V2 request", () => {
    const payload = {
      acknowledgementPath: String.raw`C:\Program Files (x86)\WonRemote Agent\.update-handoff\123e4567-e89b-42d3-a456-426614174000\installer-started.accepted`,
      installerPath: String.raw`C:\Users\test\AppData\Roaming\WonRemote\updates\installer.exe`,
      installerSha256: "a".repeat(64),
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      scriptPath: String.raw`C:\Users\test\AppData\Roaming\WonRemote\updates\run-installer-update-123e4567-e89b-42d3-a456-426614174000.ps1`,
      scriptSha256: "b".repeat(64),
    };
    const request = formatInstallerUpdateHandoffBrokerRequest(payload);
    expect(request.startsWith(INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX)).toBe(true);
    expect(JSON.parse(Buffer.from(
      request.slice(INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX.length),
      "base64url",
    ).toString("utf8"))).toEqual({ version: 2, ...payload });
  });

  it("allows Task Scheduler cold start without abandoning the healthy Agent", () => {
    expect(UPDATE_HANDOFF_ACKNOWLEDGEMENT_TIMEOUT_MS).toBe(30_000);
  });
});
