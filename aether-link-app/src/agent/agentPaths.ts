import fs from "node:fs";
import path from "node:path";

type AgentPathEnv = {
  readonly WONREMOTE_APP_DIR?: string;
  readonly WONREMOTE_POC_PATH?: string;
};

export interface AgentCaptureSpawnPlan {
  args: string[];
  secure: boolean;
}

export interface AgentDesktopCaptureTransition {
  secureDesktop: boolean;
  restartRequired: boolean;
}

export interface AppliedAgentDesktopCaptureTransition extends AgentDesktopCaptureTransition {
  restartRequested: boolean;
}

export function nextSecureDesktopCaptureState(
  current: boolean,
  sessionChanged: boolean,
  eventType?: unknown,
): boolean {
  if (sessionChanged) return false;
  if (eventType === "secure-desktop-required") return true;
  if (eventType === "default-desktop-required") return false;
  return current;
}

export function resolveAgentDesktopCaptureTransition(
  current: boolean,
  eventType: unknown,
): AgentDesktopCaptureTransition {
  const secureDesktop = nextSecureDesktopCaptureState(current, false, eventType);
  return {
    secureDesktop,
    restartRequired: secureDesktop !== current,
  };
}

export function applyAgentDesktopCaptureTransition(
  current: boolean,
  eventType: unknown,
  requestRestart: () => boolean,
): AppliedAgentDesktopCaptureTransition {
  const transition = resolveAgentDesktopCaptureTransition(current, eventType);
  if (!transition.restartRequired) {
    return { ...transition, restartRequested: false };
  }
  const restartRequested = requestRestart();
  return {
    secureDesktop: restartRequested ? transition.secureDesktop : current,
    restartRequired: true,
    restartRequested,
  };
}

export function resolveAgentAppDir(env: AgentPathEnv, defaultAppDir: string): string {
  return path.resolve(env.WONREMOTE_APP_DIR?.trim() || defaultAppDir);
}

export function resolveAgentPocPath(env: AgentPathEnv, appDir: string): string {
  if (env.WONREMOTE_POC_PATH?.trim()) {
    return path.resolve(env.WONREMOTE_POC_PATH.trim());
  }

  // 1. Packaged agent standalone layout: bin/wonremote-poc.exe under appDir
  const localPoc = path.join(appDir, "bin", "wonremote-poc.exe");
  if (fs.existsSync(localPoc)) {
    return path.resolve(localPoc);
  }

  // 2. Tauri resources layout: ../bin/wonremote-poc.exe relative to appDir (resource_dir)
  const parentPoc = path.join(appDir, "..", "bin", "wonremote-poc.exe");
  if (fs.existsSync(parentPoc)) {
    return path.resolve(parentPoc);
  }

  // 3. Fallback to development layout
  return path.resolve(
    path.join(appDir, "..", "aether-link-poc", "target", "release", "wonremote-poc.exe"),
  );
}

export function resolveAgentCaptureSpawnPlan(
  _env: AgentPathEnv,
  directArgs: string[],
  _secureDesktop: boolean,
): AgentCaptureSpawnPlan {
  return {
    args: ["--mode", "secure-client", ...directArgs.slice(2)],
    secure: true,
  };
}
