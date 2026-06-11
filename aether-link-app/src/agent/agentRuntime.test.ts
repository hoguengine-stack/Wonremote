import { describe, expect, it, vi } from "vitest";
import { resolveAgentCredentials } from "./agentRuntime";

describe("agent runtime", () => {
  it("uses environment credentials without prompting", async () => {
    const promptCredentials = vi.fn(async () => ({
      businessNumber: "0000000000",
      password: "wrong",
    }));

    const credentials = await resolveAgentCredentials(
      {
        AETHER_LINK_AGENT_ID: "4445566666",
        AETHER_LINK_AGENT_PASSWORD: "1234",
      },
      promptCredentials,
    );

    expect(credentials).toEqual({
      businessNumber: "4445566666",
      password: "1234",
    });
    expect(promptCredentials).not.toHaveBeenCalled();
  });
});
