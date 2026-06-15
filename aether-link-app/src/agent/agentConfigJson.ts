import type { AgentLocalConfig } from "./agentBootstrap";

export function parseAgentConfigJson(content: string): AgentLocalConfig {
  return JSON.parse(content.replace(/^\uFEFF/, "")) as AgentLocalConfig;
}
