import type { AgentFirstRunInput, AgentFirstRunResult, ManagedDevice } from "../domain/types";

export interface AgentCredentials {
  businessNumber: string;
  password: string;
}

export interface AgentLocalConfig {
  businessNumber?: string;
  installId: string;
  registeredAt?: string;
  registeredDeviceId?: string;
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
  });
  const config: AgentLocalConfig = {
    businessNumber: result.device.businessNumber,
    installId,
    registeredAt: deps.nowIso(),
    registeredDeviceId: result.device.id,
  };
  await deps.writeConfig(config);

  return {
    config,
    device: result.device,
    status: "registered",
  };
}
