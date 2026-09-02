import type { AgentFirstRunInput, AgentFirstRunResult, ManagedDevice } from "../domain/types";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { CURRENT_REMOTE_PROTOCOL_VERSION } from "../domain/remoteProtocol";

export interface AgentCredentials {
  businessNumber: string;
  password: string;
}

export interface AgentLocalConfig {
  apiUrl?: string;
  businessNumber?: string;
  desktopName?: string;
  installId: string;
  registeredAt?: string;
  registeredDeviceId?: string;
  version?: string;
}

export interface AgentBootstrapDeps {
  createInstallId: () => string;
  nowIso: () => string;
  promptCredentials: () => Promise<AgentCredentials>;
  readConfig: () => Promise<AgentLocalConfig | null>;
  registerFirstRun: (input: AgentFirstRunInput) => Promise<AgentFirstRunResult>;
  writeConfig: (config: AgentLocalConfig) => Promise<void>;
}

export type AgentBootstrapResult =
  | {
      config: AgentLocalConfig;
      status: "already_registered";
    }
  | {
      config: AgentLocalConfig;
      device: ManagedDevice;
      status: "registered";
    };

export async function bootstrapAgent(deps: AgentBootstrapDeps): Promise<AgentBootstrapResult> {
  const existingConfig = await deps.readConfig();
  if (existingConfig?.registeredDeviceId) {
    if (existingConfig.version !== WONREMOTE_APP_VERSION) {
      existingConfig.version = WONREMOTE_APP_VERSION;
      await deps.writeConfig(existingConfig);
    }
    return {
      config: existingConfig,
      status: "already_registered",
    };
  }

  const installId = existingConfig?.installId ?? deps.createInstallId();
  const credentials = await deps.promptCredentials();
  const result = await deps.registerFirstRun({
    businessNumber: credentials.businessNumber,
    password: credentials.password,
    installId,
    protocolVersion: CURRENT_REMOTE_PROTOCOL_VERSION,
    version: WONREMOTE_APP_VERSION,
  });
  const config: AgentLocalConfig = {
    businessNumber: result.device.businessNumber,
    desktopName: result.device.desktopName,
    installId,
    registeredAt: deps.nowIso(),
    registeredDeviceId: result.device.id,
    version: WONREMOTE_APP_VERSION,
  };
  await deps.writeConfig(config);

  return {
    config,
    device: result.device,
    status: "registered",
  };
}
