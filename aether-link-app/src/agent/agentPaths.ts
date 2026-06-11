import path from "node:path";

type AgentPathEnv = {
  readonly AETHER_LINK_APP_DIR?: string;
  readonly AETHER_LINK_POC_PATH?: string;
};

export function resolveAgentAppDir(env: AgentPathEnv, defaultAppDir: string): string {
  return path.resolve(env.AETHER_LINK_APP_DIR?.trim() || defaultAppDir);
}

export function resolveAgentPocPath(env: AgentPathEnv, appDir: string): string {
  return path.resolve(
    env.AETHER_LINK_POC_PATH?.trim() ||
      path.join(appDir, "..", "aether-link-poc", "target", "release", "aether-link-poc.exe"),
  );
}
