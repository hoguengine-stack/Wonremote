import { describe, expect, it } from "vitest";
import type { AgentCommand } from "./types";
import { orderAgentCommands } from "./agentCommandOrdering";

describe("Agent command ordering", () => {
  it("restores creation order before executing button and key transitions", () => {
    const commands: AgentCommand[] = [
      command("up", "mouse-up 10 20 left", "2026-08-18T00:00:00.002Z"),
      command("down", "mouse-down 10 20 left", "2026-08-18T00:00:00.001Z"),
    ];

    expect(orderAgentCommands(commands).map(({ action }) => action)).toEqual([
      "mouse-down 10 20 left",
      "mouse-up 10 20 left",
    ]);
  });

  it("does not mutate the Firestore snapshot array", () => {
    const commands = [
      command("second", "key-up Ctrl", "2026-08-18T00:00:00.002Z"),
      command("first", "key-down Ctrl", "2026-08-18T00:00:00.001Z"),
    ];

    orderAgentCommands(commands);
    expect(commands.map(({ id }) => id)).toEqual(["second", "first"]);
  });
});

function command(id: string, action: string, createdAt: string): AgentCommand {
  return { id, action, createdAt, deviceId: "device-1", sessionId: "session-1" };
}
