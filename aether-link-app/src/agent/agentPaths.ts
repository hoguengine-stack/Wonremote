import fs from "node:fs";
import path from "node:path";

type AgentPathEnv = {
  readonly AETHER_LINK_APP_DIR?: string;
  readonly AETHER_LINK_POC_PATH?: string;
};

export function resolveAgentAppDir(env: AgentPathEnv, defaultAppDir: string): string {
  return path.resolve(env.AETHER_LINK_APP_DIR?.trim() || defaultAppDir);
}

export function resolveAgentPocPath(env: AgentPathEnv, appDir: string): string {
  if (env.AETHER_LINK_POC_PATH?.trim()) {
    return path.resolve(env.AETHER_LINK_POC_PATH.trim());
  }

  // 1. Packaged agent standalone layout: bin/aether-link-poc.exe under appDir
  const localPoc = path.join(appDir, "bin", "aether-link-poc.exe");
  if (fs.existsSync(localPoc)) {
    return path.resolve(localPoc);
  }

  // 2. Tauri resources layout: ../bin/aether-link-poc.exe relative to appDir (resource_dir)
  const parentPoc = path.join(appDir, "..", "bin", "aether-link-poc.exe");
  if (fs.existsSync(parentPoc)) {
    return path.resolve(parentPoc);
  }

  // 3. Fallback to development layout
  return path.resolve(
    path.join(appDir, "..", "aether-link-poc", "target", "release", "aether-link-poc.exe"),
  );
}
