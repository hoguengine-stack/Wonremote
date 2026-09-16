export const UPDATE_HANDOFF_BROKER_PREFIX = "[WonRemoteUpdateHandoff]";
export const INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX = "[WonRemoteUpdateHandoffV2]";
export const AGENT_UPDATE_HANDOFF_EXIT_CODE = 42;
export const UPDATE_HANDOFF_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;

export type InstallerUpdateHandoffBrokerRequest = {
  acknowledgementPath: string;
  installerPath: string;
  installerSha256: string;
  requestId: string;
  scriptPath: string;
  scriptSha256: string;
  version: 2;
};

export function isUpdateHandoffBrokerEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function encodeUpdateHandoffScriptPath(scriptPath: string): string {
  return Buffer.from(scriptPath, "utf8").toString("base64url");
}

export function formatUpdateHandoffBrokerRequest(scriptPath: string): string {
  return `${UPDATE_HANDOFF_BROKER_PREFIX}${encodeUpdateHandoffScriptPath(scriptPath)}`;
}

export function formatInstallerUpdateHandoffBrokerRequest(
  request: Omit<InstallerUpdateHandoffBrokerRequest, "version">,
): string {
  const payload: InstallerUpdateHandoffBrokerRequest = { version: 2, ...request };
  return `${INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function updateHandoffAcknowledgementPath(scriptPath: string): string {
  return `${scriptPath}.accepted`;
}
