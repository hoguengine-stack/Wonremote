import type {
  AgentConnectionInput,
  AgentFirstRunInput,
  AgentFirstRunResult,
  AgentRegistrationResult,
  ManagedDevice,
  RemoteSession,
  ChatMessage,
  ClipboardData,
  TransferredFile,
  ConnectionHistoryEntry,
  DeviceMetadataUpdateInput,
} from "../domain/types";
import {
  closeFirebaseSession,
  fetchFirebaseSessionStatus,
  isViewerFirebaseEnabled,
  loginViewerWithFirebase,
  openFirebaseSession,
  recordFirebaseInput,
  registerFirstRunAgentWithFirebase,
  updateFirebaseDeviceMetadata,
} from "../firebase/viewerFirebase";

const API_BASE_URL = import.meta.env.VITE_WONREMOTE_API_URL ?? "http://127.0.0.1:8787";

export async function loginAdmin(username: string, password: string): Promise<void> {
  if (isViewerFirebaseEnabled()) {
    await loginViewerWithFirebase(username, password);
    return;
  }

  await request("/api/admin/login", {
    method: "POST",
    body: { username, password },
  });
}

export async function fetchDevices(): Promise<ManagedDevice[]> {
  const body = await request<{ devices: ManagedDevice[] }>("/api/devices");
  return body.devices;
}

export async function updateDeviceMetadata(
  deviceId: string,
  input: Omit<DeviceMetadataUpdateInput, "deviceId">,
): Promise<ManagedDevice> {
  if (isViewerFirebaseEnabled()) {
    return updateFirebaseDeviceMetadata(deviceId, input);
  }

  const body = await request<{ device: ManagedDevice }>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    body: input,
  });
  return body.device;
}

export async function connectAgent(input: AgentConnectionInput): Promise<
  AgentRegistrationResult & { inputLog: string[] }
> {
  return request("/api/agent/connect", {
    method: "POST",
    body: input,
  });
}

export async function registerFirstRunAgent(input: AgentFirstRunInput & { apiUrl?: string }): Promise<AgentFirstRunResult> {
  if (isViewerFirebaseEnabled()) {
    return registerFirstRunAgentWithFirebase(input);
  }

  const baseUrl = input.apiUrl ?? API_BASE_URL;
  if (input.apiUrl) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/agent/first-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessNumber: input.businessNumber,
          password: input.password,
          installId: input.installId,
        }),
      });
    } catch {
      throw new Error("WonRemote API 서버에 연결할 수 없습니다.");
    }

    const payload = (await response.json()) as AgentFirstRunResult & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Agent 등록 실패");
    }
    return payload;
  }

  return request("/api/agent/first-run", {
    method: "POST",
    body: input,
  });
}

export async function openSession(deviceId: string): Promise<{
  session: RemoteSession;
  inputLog: string[];
}> {
  if (isViewerFirebaseEnabled()) {
    return openFirebaseSession(deviceId);
  }

  return request("/api/sessions", {
    method: "POST",
    body: { deviceId },
  });
}

export async function requestSecureSession(deviceId: string): Promise<{ challengeId: string; expiresAt: string }> {
  if (isViewerFirebaseEnabled()) {
    throw new Error("Firebase secure connection requires Cloud Functions validation.");
  }

  return request("/api/sessions/secure-request", {
    method: "POST",
    body: { deviceId },
  });
}

export async function connectSecureSession(input: {
  challengeId: string;
  code: string;
  deviceId: string;
}): Promise<{
  session: RemoteSession;
  inputLog: string[];
}> {
  if (isViewerFirebaseEnabled()) {
    throw new Error("Firebase secure connection requires Cloud Functions validation.");
  }

  return request("/api/sessions/secure-connect", {
    method: "POST",
    body: input,
  });
}

export async function connectByCode(connectionCode: string): Promise<{
  session: RemoteSession;
  inputLog: string[];
}> {
  return request("/api/sessions/connect-code", {
    method: "POST",
    body: { connectionCode },
  });
}

export async function recordInput(sessionId: string, action: string): Promise<string[]> {
  if (isViewerFirebaseEnabled()) {
    return recordFirebaseInput(sessionId, action);
  }

  const body = await request<{ inputLog: string[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/input`,
    {
      method: "POST",
      body: { action },
    },
  );
  return body.inputLog;
}

export async function closeSession(sessionId: string): Promise<void> {
  if (isViewerFirebaseEnabled()) {
    await closeFirebaseSession(sessionId);
    return;
  }

  await request(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: "POST",
  });
}

export async function approveSession(sessionId: string, approved: boolean): Promise<RemoteSession> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/approve`, {
    method: "POST",
    body: { approved },
  });
}

export async function sendChatMessage(sessionId: string, message: string, sender: "viewer" | "agent"): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: "POST",
    body: { message, sender },
  });
}

export async function fetchChatMessages(sessionId: string): Promise<ChatMessage[]> {
  const body = await request<{ messages: ChatMessage[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`);
  return body.messages;
}

export async function sendClipboardText(sessionId: string, text: string, sender: "viewer" | "agent"): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/clipboard`, {
    method: "POST",
    body: { text, sender },
  });
}

export async function fetchClipboardText(sessionId: string): Promise<ClipboardData[]> {
  const body = await request<{ clipboards: ClipboardData[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/clipboard`);
  return body.clipboards;
}

export async function uploadFileChunk(
  sessionId: string,
  input: {
    filename: string;
    fileData: string;
    transferId: string;
    chunkIndex: number;
    totalChunks: number;
    totalBytes: number;
    isLast: boolean;
  },
): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
    method: "POST",
    body: input,
  });
}

export async function fetchFiles(sessionId: string): Promise<TransferredFile[]> {
  const body = await request<{ files: TransferredFile[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
  return body.files;
}

export async function fetchConnectionHistory(): Promise<ConnectionHistoryEntry[]> {
  const body = await request<{ history: ConnectionHistoryEntry[] }>("/api/connection-history");
  return body.history;
}

export async function fetchSessionStatus(sessionId: string): Promise<"pending" | "connected"> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseSessionStatus(sessionId);
  }

  const body = await request<{ state: "pending" | "connected" }>(`/api/sessions/${encodeURIComponent(sessionId)}/status`);
  return body.state;
}


async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error("로컬 API 서버에 연결할 수 없습니다.");
  }

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "API 요청 실패");
  }
  return payload;
}
