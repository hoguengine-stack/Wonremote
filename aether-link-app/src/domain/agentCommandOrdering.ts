import type { AgentCommand } from "./types";

export function orderAgentCommands(commands: AgentCommand[]): AgentCommand[] {
  return [...commands].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
  });
}
