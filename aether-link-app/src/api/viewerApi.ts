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
  FileTransferReceipt,
  ConnectionHistoryEntry,
  DeviceMetadataUpdateInput,
} from "../domain/types";
import {
  FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES,
  canUseFirestoreDirectFilePayload,
  canUseFirestoreDirectFileTransfer,
} from "../domain/fileTransferPolicy";
import {
  closeFirebaseSession,
  fetchFirebaseChatMessages,
  fetchFirebaseDevices,
  fetchFirebaseClipboardText,
  fetchFirebaseFileTransferReceipts,
  fetchFirebaseFiles,
  fetchFirebaseSessionStatus,
  fetchFirebaseTiles,
  isViewerFirebaseEnabled,
  loginViewerWithFirebase,
  logoutViewerWithFirebase,
  connectFirebaseSecureSession,
  openFirebaseSession,
  recordFirebaseInput,
  registerFirstRunAgentWithFirebase,
  requestFirebaseSecureSession,
  sendFirebaseChatMessage,
  sendFirebaseClipboardText,
  updateFirebaseDeviceMetadata,
  uploadFirebaseFileChunk,
  uploadFirebaseFileToStorage,
} from "../firebase/viewerFirebase";

const API_BASE_URL = import.meta.env.VITE_WONREMOTE_API_URL ?? "http://127.0.0.1:8787";
const LOCAL_API_CONNECTION_ERROR =
  "WonRemote 연결에 실패했습니다. Firebase 설정 또는 내장 API 실행 상태를 확인해 주세요.";

export async function loginAdmin(username: string, password: string): Promise<void> {
  if (isViewerFirebaseEnabled()) {
    if (username.trim() === "admin") {
      throw new Error("Firebase 연동 모드에서는 'admin' 계정을 사용할 수 없습니다. 등록된 이메일 계정으로 로그인해 주세요.");
    }
    await loginViewerWithFirebase(username, password);
    return;
  }

  await request("/api/admin/login", {
    method: "POST",
    body: { username, password },
  });
}

export async function logoutAdmin(): Promise<void> {
  if (isViewerFirebaseEnabled()) {
    await logoutViewerWithFirebase();
  }
}

export async function fetchDevices(): Promise<ManagedDevice[]> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseDevices();
  }

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
          version: input.version,
        }),
      });
    } catch {
      throw new Error(LOCAL_API_CONNECTION_ERROR);
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
    return requestFirebaseSecureSession(deviceId);
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
    return connectFirebaseSecureSession(input);
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
  if (isViewerFirebaseEnabled()) {
    await sendFirebaseChatMessage(sessionId, message, sender);
    return;
  }

  await request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: "POST",
    body: { message, sender },
  });
}

export async function fetchChatMessages(sessionId: string): Promise<ChatMessage[]> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseChatMessages(sessionId);
  }

  const body = await request<{ messages: ChatMessage[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`);
  return body.messages;
}

export async function sendClipboardText(sessionId: string, text: string, sender: "viewer" | "agent"): Promise<void> {
  if (isViewerFirebaseEnabled()) {
    await sendFirebaseClipboardText(sessionId, text, sender);
    return;
  }

  await request(`/api/sessions/${encodeURIComponent(sessionId)}/clipboard`, {
    method: "POST",
    body: { text, sender },
  });
}

export async function fetchClipboardText(sessionId: string): Promise<ClipboardData[]> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseClipboardText(sessionId);
  }

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
    chunkSha256?: string;
    fileSha256?: string;
  },
): Promise<void> {
  if (isViewerFirebaseEnabled()) {
    if (!canUseFirestoreDirectFileTransfer(input.totalBytes)) {
      throw new Error(
        `Firebase direct file transfer is limited to ${Math.floor(FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES / (1024 * 1024))}MB until Firebase Storage or WebRTC file transport is enabled.`,
      );
    }
    const payloadBytes = Math.floor((input.fileData.length * 3) / 4);
    if (!canUseFirestoreDirectFilePayload(payloadBytes)) {
      throw new Error("Firebase direct file chunk is too large for one Firestore document.");
    }
    await uploadFirebaseFileChunk(sessionId, input);
    return;
  }

  await request(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
    method: "POST",
    body: input,
  });
}

export async function uploadFileToStorage(
  sessionId: string,
  input: {
    file: Blob;
    filename: string;
    transferId: string;
    totalBytes: number;
    fileSha256?: string;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
  },
): Promise<void> {
  if (!isViewerFirebaseEnabled()) {
    throw new Error("Storage file upload is only available in Firebase mode.");
  }
  await uploadFirebaseFileToStorage(sessionId, input);
}

export async function fetchFiles(sessionId: string): Promise<TransferredFile[]> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseFiles(sessionId);
  }

  const body = await request<{ files: TransferredFile[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
  return body.files;
}

export async function fetchFileTransferReceipts(sessionId: string): Promise<FileTransferReceipt[]> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseFileTransferReceipts(sessionId);
  }

  const body = await request<{ receipts: FileTransferReceipt[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file-receipts`,
  );
  return body.receipts;
}

export async function fetchTiles(sessionId: string): Promise<{ tiles: any[]; width: number; height: number }> {
  if (isViewerFirebaseEnabled()) {
    return fetchFirebaseTiles(sessionId);
  }

  const response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/tiles`);
  if (!response.ok) {
    return { tiles: [], width: 0, height: 0 };
  }
  return response.json();
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
    throw new Error(LOCAL_API_CONNECTION_ERROR);
  }

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "API 요청 실패");
  }
  return payload;
}
