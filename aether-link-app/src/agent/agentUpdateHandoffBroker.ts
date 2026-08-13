export const UPDATE_HANDOFF_BROKER_PREFIX = "[WonRemoteUpdateHandoff]";

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

export function updateHandoffAcknowledgementPath(scriptPath: string): string {
  return `${scriptPath}.accepted`;
}
