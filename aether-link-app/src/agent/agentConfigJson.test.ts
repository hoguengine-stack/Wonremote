import { describe, expect, it } from "vitest";
import { parseAgentConfigJson } from "./agentConfigJson";

describe("agent config JSON parsing", () => {
  it("accepts UTF-8 BOM prefixed config files", () => {
    expect(
      parseAgentConfigJson('\uFEFF{"installId":"82220F6D","registeredDeviceId":"123-45-67890:AGENT-82220F6D"}'),
    ).toMatchObject({
      installId: "82220F6D",
      registeredDeviceId: "123-45-67890:AGENT-82220F6D",
    });
  });
});
