import type {
  AgentCommandPollResult,
  AgentControlDiagnostics,
  AgentHeartbeatResult,
  AgentStreamDiagnostics,
  DeviceDisplayInfo,
} from "../domain/types";
import {
  isAgentFirebaseEnabled,
  pollAgentCommandsWithFirebase,
  sendAgentHeartbeatWithFirebase,
} from "../firebase/agentFirebase";

interface SendAgentHeartbeatOptions {
  apiBaseUrl: string;
  deviceId: string;
  displays?: DeviceDisplayInfo[];
  fetchImpl?: typeof fetch;
  installId: string;
  activeDisplayIndex?: number;
  macAddresses?: string[];
  controlDiagnostics?: AgentControlDiagnostics;
  streamDiagnostics?: AgentStreamDiagnostics;
  version?: string;
}

interface PollAgentCommandsOptions {
  apiBaseUrl: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
  installId: string;
}

export async function sendAgentHeartbeat({
  apiBaseUrl,
  deviceId,
  displays,
  fetchImpl = fetch,
  installId,
  activeDisplayIndex,
  macAddresses,
  controlDiagnostics,
  streamDiagnostics,
  version,
}: SendAgentHeartbeatOptions): Promise<AgentHeartbeatResult> {
  if (isAgentFirebaseEnabled(process.env)) {
    return sendAgentHeartbeatWithFirebase({
      deviceId,
      displays,
      installId,
      activeDisplayIndex,
      macAddresses,
      controlDiagnostics,
      streamDiagnostics,
      version,
    });
  }

  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/api/agent/heartbeat`, {
      body: JSON.stringify({
        deviceId,
        installId,
        version,
        displays,
        activeDisplayIndex,
        macAddresses,
        controlDiagnostics,
        streamDiagnostics,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new Error("WonRemote API 서버에 heartbeat를 전송할 수 없습니다.");
  }

  const payload = (await response.json()) as AgentHeartbeatResult & { error?: string };
  if (!response.ok) {
    const err = new Error(payload.error ?? "Agent heartbeat 실패");
    (err as any).status = response.status;
    throw err;
  }
  return payload;
}

export async function pollAgentCommands({
  apiBaseUrl,
  deviceId,
  fetchImpl = fetch,
  installId,
}: PollAgentCommandsOptions): Promise<AgentCommandPollResult> {
  if (isAgentFirebaseEnabled(process.env)) {
    return pollAgentCommandsWithFirebase({
      deviceId,
      installId,
    });
  }

  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/api/agent/commands`, {
      body: JSON.stringify({
        deviceId,
        installId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new Error("WonRemote API 서버에서 명령을 가져올 수 없습니다.");
  }

  const payload = (await response.json()) as AgentCommandPollResult & { error?: string };
  if (!response.ok) {
    const err = new Error(payload.error ?? "Agent command polling 실패");
    (err as any).status = response.status;
    throw err;
  }
  return payload;
}
