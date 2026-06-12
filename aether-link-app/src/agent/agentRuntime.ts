import type { AgentCredentials } from "./agentBootstrap";

export async function resolveAgentCredentials(
  env: Record<string, string | undefined>,
  promptCredentials: () => Promise<AgentCredentials>,
): Promise<AgentCredentials> {
  const businessNumber = env.WONREMOTE_AGENT_ID?.trim();
  const password = env.WONREMOTE_AGENT_PASSWORD?.trim();
  if (businessNumber && password) {
    return {
      businessNumber,
      password,
    };
  }

  return promptCredentials();
}
