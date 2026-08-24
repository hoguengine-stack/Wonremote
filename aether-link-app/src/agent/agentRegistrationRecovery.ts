import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import type { AgentFirstRunInput, AgentFirstRunResult } from "../domain/types";
import { buildFirebaseDeviceId } from "../firebase/firebaseIdentity";
import type { AgentLocalConfig } from "./agentBootstrap";

export interface AgentRegistrationRecoveryDeps {
  nowIso: () => string;
  registerFirstRun: (input: AgentFirstRunInput) => Promise<AgentFirstRunResult>;
  writeConfig: (config: AgentLocalConfig) => Promise<void>;
}

export function canRecoverMissingAgentRegistration(config: AgentLocalConfig): boolean {
  return Boolean(config.businessNumber?.trim() && config.installId?.trim());
}

export async function recoverMissingAgentRegistration(
  config: AgentLocalConfig,
  deps: AgentRegistrationRecoveryDeps,
): Promise<AgentLocalConfig> {
  return reconcileAgentRegistration(config, deps);
}

export async function reconcileAgentRegistration(
  config: AgentLocalConfig,
  deps: AgentRegistrationRecoveryDeps,
): Promise<AgentLocalConfig> {
  if (!canRecoverMissingAgentRegistration(config)) {
    throw new Error("Agent registration cannot be recovered without businessNumber and installId.");
  }

  const result = await deps.registerFirstRun({
    businessNumber: config.businessNumber!,
    installId: config.installId,
    password: "1234",
    ...(config.desktopName?.trim() ? { desktopName: config.desktopName.trim() } : {}),
    ...(config.registeredDeviceId?.trim() &&
    config.registeredDeviceId.trim() !== buildFirebaseDeviceId(config.businessNumber!, config.installId)
      ? { previousDeviceId: config.registeredDeviceId.trim() }
      : {}),
    version: WONREMOTE_APP_VERSION,
  });
  const recoveredConfig: AgentLocalConfig = {
    ...config,
    businessNumber: result.device.businessNumber,
    desktopName: config.desktopName?.trim() || result.device.desktopName,
    installId: config.installId,
    registeredAt: deps.nowIso(),
    registeredDeviceId: result.device.id,
    version: WONREMOTE_APP_VERSION,
  };

  await deps.writeConfig(recoveredConfig);
  return recoveredConfig;
}
