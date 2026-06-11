import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  applyAgentHeartbeat,
  authenticateAdmin,
  registerAgentFirstRun,
  registerAgentConnection,
  resolveDeviceStatuses,
  verifyAgentInstall,
} from "../domain/agentRegistry";
import type {
  AgentCommand,
  AgentCommandPollInput,
  AgentConnectionInput,
  AgentFirstRunInput,
  AgentHeartbeatInput,
  ManagedDevice,
  RemoteSession,
  ChatMessage,
  ClipboardData,
  TransferredFile,
  ConnectionHistoryEntry,
} from "../domain/types";
import { createMemoryDeviceStore } from "./deviceStore";
import type { DeviceStore } from "./deviceStore";
import { createMemoryHistoryStore } from "./historyStore";
import type { HistoryStore } from "./historyStore";

interface ApiState {
  devices: ManagedDevice[];
  deviceStore: DeviceStore;
  historyStore: HistoryStore;
  initialized: boolean;
  now: () => Date;
  offlineAfterMs: number;
  sessions: Map<string, RemoteSession>;
  inputLogs: Map<string, string[]>;
  commandQueues: Map<string, AgentCommand[]>;
  sessionTiles: Map<string, { tiles: any[]; width: number; height: number }>;
  sessionChats: Map<string, ChatMessage[]>;
  sessionClipboards: Map<string, ClipboardData[]>;
  sessionFiles: Map<string, TransferredFile[]>;
}

interface CreateApiServerOptions {
  deviceStore?: DeviceStore;
  historyStore?: HistoryStore;
  initialDevices?: ManagedDevice[];
  now?: () => Date;
  offlineAfterMs?: number;
}


export function createApiServer(options: CreateApiServerOptions | ManagedDevice[] = []) {
  const initialDevices = Array.isArray(options) ? options : options.initialDevices ?? [];
  const deviceStore = Array.isArray(options)
    ? createMemoryDeviceStore(initialDevices)
    : options.deviceStore ?? createMemoryDeviceStore(initialDevices);
  const historyStore = Array.isArray(options)
    ? createMemoryHistoryStore()
    : options.historyStore ?? createMemoryHistoryStore();
  const state: ApiState = {
    devices: initialDevices,
    deviceStore,
    historyStore,
    initialized: false,
    now: Array.isArray(options) ? () => new Date() : options.now ?? (() => new Date()),
    offlineAfterMs: Array.isArray(options) ? 30_000 : options.offlineAfterMs ?? 30_000,
    sessions: new Map(),
    inputLogs: new Map(),
    commandQueues: new Map(),
    sessionTiles: new Map(),
    sessionChats: new Map(),
    sessionClipboards: new Map(),
    sessionFiles: new Map(),
  };


  return createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      await routeRequest(state, request, response);
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  });
}

async function routeRequest(
  state: ApiState,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readJson<{ username?: string; password?: string }>(request);
    if (!authenticateAdmin(body.username ?? "", body.password ?? "")) {
      writeJson(response, 401, { error: "관리자 계정을 확인하세요." });
      return;
    }
    writeJson(response, 200, { ok: true });
    return;
  }

  await ensureDevicesLoaded(state);

  if (request.method === "GET" && url.pathname === "/api/devices") {
    writeJson(response, 200, {
      devices: resolveDeviceStatuses(state.devices, nowIso(state), state.offlineAfterMs),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/first-run") {
    const input = await readJson<AgentFirstRunInput>(request);
    try {
      const result = registerAgentFirstRun(state.devices, input, nowIso(state));
      state.devices = result.devices;
      await state.deviceStore.writeDevices(state.devices);
      writeJson(response, 200, {
        devices: state.devices,
        device: result.device,
      });
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "Agent 최초 등록 실패",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/heartbeat") {
    const input = await readJson<AgentHeartbeatInput>(request);
    try {
      const result = applyAgentHeartbeat(state.devices, input, nowIso(state));
      state.devices = result.devices;
      await state.deviceStore.writeDevices(state.devices);
      writeJson(response, 200, {
        device: result.device,
      });
    } catch (error) {
      writeJson(response, 404, {
        error: error instanceof Error ? error.message : "Agent heartbeat 실패",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/commands") {
    const input = await readJson<AgentCommandPollInput>(request);
    try {
      verifyAgentInstall(state.devices, input.deviceId, input.installId);
      const commands = state.commandQueues.get(input.deviceId) ?? [];
      state.commandQueues.set(input.deviceId, []);
      writeJson(response, 200, { commands });
    } catch (error) {
      writeJson(response, 404, {
        error: error instanceof Error ? error.message : "Agent command polling 실패",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/connect") {
    const input = await readJson<AgentConnectionInput>(request);
    try {
      const result = registerAgentConnection(state.devices, input, nowIso(state));
      state.devices = result.devices;
      await state.deviceStore.writeDevices(state.devices);
      state.sessions.set(result.session.id, result.session);
      state.inputLogs.set(result.session.id, [
        `${new Date().toLocaleTimeString()} 세션 연결`,
      ]);
      writeJson(response, 200, {
        devices: state.devices,
        session: result.session,
        inputLog: state.inputLogs.get(result.session.id) ?? [],
      });
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "Agent 접속 실패",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson<{ deviceId?: string }>(request);
    const deviceId = String(body.deviceId ?? "").trim();
    const device = state.devices.find((item) => item.id === deviceId);
    if (!device) {
      writeJson(response, 404, { error: "장비를 찾을 수 없습니다." });
      return;
    }

    const session: RemoteSession = {
      id: `session-${device.id}`,
      deviceId: device.id,
      state: "pending",
      startedAt: nowIso(state),
    };
    state.sessions.set(session.id, session);
    state.inputLogs.set(session.id, [`${new Date().toLocaleTimeString()} 접속 승인 대기 중`]);
    enqueueAgentCommand(state, session.deviceId, "request-approval");
    writeJson(response, 200, {
      session,
      inputLog: state.inputLogs.get(session.id) ?? [],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/connect-code") {
    const body = await readJson<{ connectionCode?: string }>(request);
    const code = String(body.connectionCode ?? "").trim();
    if (!code) {
      writeJson(response, 400, { error: "접속 코드를 입력해야 합니다." });
      return;
    }

    const device = state.devices.find((item) => item.connectionCode === code);
    if (!device) {
      writeJson(response, 404, { error: "해당 접속 코드를 가진 장비를 찾을 수 없습니다." });
      return;
    }

    const session: RemoteSession = {
      id: `session-${device.id}`,
      deviceId: device.id,
      state: "pending",
      startedAt: nowIso(state),
    };
    state.sessions.set(session.id, session);
    state.inputLogs.set(session.id, [`${new Date().toLocaleTimeString()} 접속 승인 대기 중`]);
    enqueueAgentCommand(state, session.deviceId, "request-approval");
    writeJson(response, 200, {
      session,
      inputLog: state.inputLogs.get(session.id) ?? [],
    });
    return;
  }


  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/input$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }

      const body = await readJson<{ action?: string }>(request);
      const action = String(body.action ?? "").trim();
      if (!action) {
        writeJson(response, 400, { error: "입력 이벤트가 비어 있습니다." });
        return;
      }

      const nextLog = [
        `${new Date().toLocaleTimeString()} ${action}`,
        ...(state.inputLogs.get(sessionId) ?? []),
      ].slice(0, 6);
      state.inputLogs.set(sessionId, nextLog);
      const session = state.sessions.get(sessionId);
      if (session) {
        enqueueAgentCommand(state, session.deviceId, action);
      }
      writeJson(response, 200, { inputLog: nextLog });
      return;
    }
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/close$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      const session = state.sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      state.sessions.delete(sessionId);
      enqueueAgentCommand(state, session.deviceId, "stop-stream");

      // Connection history update
      const histories = await state.historyStore.readHistory();
      const entry = histories.find(h => h.id.includes(sessionId) && h.status === "success" && !h.endedAt);
      if (entry) {
        entry.endedAt = nowIso(state);
        entry.status = "closed";
        await state.historyStore.writeHistory(histories);
      }

      writeJson(response, 200, { ok: true });
      return;
    }
  }

  // 1. GET /api/connection-history
  if (request.method === "GET" && url.pathname === "/api/connection-history") {
    const history = await state.historyStore.readHistory();
    writeJson(response, 200, { history });
    return;
  }

  // 2. GET /api/update/check
  if (request.method === "GET" && url.pathname === "/api/update/check") {
    writeJson(response, 200, {
      latestVersion: "1.1.0",
      forceUpdate: false,
      downloadUrl: "http://127.0.0.1:8787/api/update/download"
    });
    return;
  }

  // 3. POST /api/sessions/:id/approve
  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/approve$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      const session = state.sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const body = await readJson<{ approved?: boolean }>(request);
      const approved = !!body.approved;

      const device = state.devices.find((d) => d.id === session.deviceId);

      if (approved) {
        session.state = "connected";
        state.inputLogs.set(sessionId, [
          `${new Date().toLocaleTimeString()} 세션 연결 승인 완료`,
          ...(state.inputLogs.get(sessionId) ?? [])
        ]);
        enqueueAgentCommand(state, session.deviceId, "start-stream");

        if (device) {
          await state.historyStore.addHistoryEntry({
            id: `hist-${sessionId}-${Date.now()}`,
            deviceId: device.id,
            storeName: device.storeName,
            deviceName: device.deviceName,
            startedAt: nowIso(state),
            status: "success",
          });
        }
      } else {
        state.sessions.delete(sessionId);
        if (device) {
          await state.historyStore.addHistoryEntry({
            id: `hist-${sessionId}-${Date.now()}`,
            deviceId: device.id,
            storeName: device.storeName,
            deviceName: device.deviceName,
            startedAt: nowIso(state),
            endedAt: nowIso(state),
            status: "rejected",
          });
        }
      }

      writeJson(response, 200, { ok: true, state: session.state });
      return;
    }
  }

  // 4. POST & GET /api/sessions/:id/chat
  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/chat$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const body = await readJson<{ message?: string; sender?: "viewer" | "agent" }>(request);
      const message = String(body.message ?? "").trim();
      const sender = body.sender ?? "viewer";

      if (!message) {
        writeJson(response, 400, { error: "메시지가 비어 있습니다." });
        return;
      }

      const chats = state.sessionChats.get(sessionId) ?? [];
      const newMsg: ChatMessage = {
        id: `chat-${chats.length + 1}-${Date.now()}`,
        message,
        sender,
        createdAt: nowIso(state),
      };
      state.sessionChats.set(sessionId, [...chats, newMsg]);

      state.inputLogs.set(sessionId, [
        `${new Date().toLocaleTimeString()} [채팅] ${sender === "viewer" ? "뷰어" : "에이전트"}: ${message.slice(0, 15)}`,
        ...(state.inputLogs.get(sessionId) ?? [])
      ]);

      writeJson(response, 200, { ok: true, message: newMsg });
      return;
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/chat$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const messages = state.sessionChats.get(sessionId) ?? [];
      state.sessionChats.set(sessionId, []); // 큐 비우기
      writeJson(response, 200, { messages });
      return;
    }
  }

  // 5. POST & GET /api/sessions/:id/clipboard
  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/clipboard$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const body = await readJson<{ text?: string; sender?: "viewer" | "agent" }>(request);
      const text = String(body.text ?? "");
      const sender = body.sender ?? "viewer";

      const clipboards = state.sessionClipboards.get(sessionId) ?? [];
      state.sessionClipboards.set(sessionId, [...clipboards, { text, sender }]);
      writeJson(response, 200, { ok: true });
      return;
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/clipboard$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const clipboards = state.sessionClipboards.get(sessionId) ?? [];
      state.sessionClipboards.set(sessionId, []); // 큐 비우기
      writeJson(response, 200, { clipboards });
      return;
    }
  }

  // 6. POST & GET /api/sessions/:id/files
  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/files$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const body = await readJson<{ filename?: string; fileData?: string }>(request);
      const filename = String(body.filename ?? "").trim();
      const fileData = String(body.fileData ?? "");

      if (!filename || !fileData) {
        writeJson(response, 400, { error: "파일명 또는 파일 데이터가 없습니다." });
        return;
      }

      if (fileData.length > 15 * 1024 * 1024) {
        writeJson(response, 400, { error: "파일 크기는 10MB를 초과할 수 없습니다." });
        return;
      }

      const files = state.sessionFiles.get(sessionId) ?? [];
      const newFile: TransferredFile = {
        id: `file-${files.length + 1}-${Date.now()}`,
        filename,
        fileData,
      };
      state.sessionFiles.set(sessionId, [...files, newFile]);
      writeJson(response, 200, { ok: true, file: { id: newFile.id, filename: newFile.filename } });
      return;
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/files$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const files = state.sessionFiles.get(sessionId) ?? [];
      state.sessionFiles.set(sessionId, []); // 큐 비우기
      writeJson(response, 200, { files });
      return;
    }
  }


  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/tiles$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const body = await readJson<{ tiles?: any[]; width?: number; height?: number }>(request);
      state.sessionTiles.set(sessionId, {
        tiles: body.tiles ?? [],
        width: body.width ?? 0,
        height: body.height ?? 0,
      });
      writeJson(response, 200, { ok: true });
      return;
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/tiles$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      if (!state.sessions.has(sessionId)) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      const data = state.sessionTiles.get(sessionId) ?? { tiles: [], width: 0, height: 0 };
      state.sessionTiles.set(sessionId, { tiles: [], width: data.width, height: data.height });
      writeJson(response, 200, data);
      return;
    }
  }

  // Session status query endpoint
  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const match = url.pathname.match(/^\/api\/sessions\/(.+)\/status$/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      const session = state.sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
        return;
      }
      writeJson(response, 200, { state: session.state });
      return;
    }
  }

  writeJson(response, 404, { error: "Not found" });
}

function enqueueAgentCommand(state: ApiState, deviceId: string, action: string): void {
  const commands = state.commandQueues.get(deviceId) ?? [];
  state.commandQueues.set(
    deviceId,
    [
      ...commands,
      {
        action,
        createdAt: nowIso(state),
        deviceId,
        id: `cmd-${commands.length + 1}-${Date.now()}`,
      },
    ].slice(-50),
  );
}

function nowIso(state: ApiState): string {
  return state.now().toISOString();
}

async function ensureDevicesLoaded(state: ApiState): Promise<void> {
  if (state.initialized) {
    return;
  }

  state.devices = await state.deviceStore.readDevices();
  state.initialized = true;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "http://127.0.0.1:5173");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
