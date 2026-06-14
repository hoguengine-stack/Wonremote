import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
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
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { REMOTE_FILE_MAX_BYTES, remoteFileLimitLabel } from "../domain/fileTransferPolicy";
import {
  parseProductionUpdateManifest,
  type ProductionUpdateMetadata,
} from "../domain/updateManifest";
import { nextPatchVersion } from "../domain/versioning";

let goodChecksum = "";
let badBinaryChecksum = "";
let goodUpdatePath = "";
let badUpdatePath = "";
let testUpdateMode: "none" | "good" | "bad_checksum" | "bad_binary" = "none";

function writeStagedAppVersion(stageDir: string, version: string) {
  const appVersionPath = path.join(stageDir, "src", "domain", "appVersion.ts");
  if (existsSync(appVersionPath)) {
    writeFileSync(appVersionPath, `export const WONREMOTE_APP_VERSION = "${version}";\n`, "utf8");
  }
}

function prepareUpdateFiles() {
  const artifactDir = resolveUpdateArtifactDir();
  const stagingRoot = path.join(artifactDir, "staging");
  const goodStageDir = path.join(stagingRoot, "good");
  const badStageDir = path.join(stagingRoot, "bad");
  const sourceDir = resolveUpdateSourceDir();
  goodUpdatePath = path.join(artifactDir, "wonremote-update-good.zip");
  badUpdatePath = path.join(artifactDir, "wonremote-update-bad.zip");

  if (!existsSync(path.join(sourceDir, "src"))) {
    console.log("[API Server] src directory not found, skipping update zip preparation.");
    return;
  }

  try {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(goodUpdatePath, { force: true });
    rmSync(badUpdatePath, { force: true });
    mkdirSync(goodStageDir, { recursive: true });
    mkdirSync(badStageDir, { recursive: true });

    // 1. Good Update Package
    cpSync(path.join(sourceDir, "src"), path.join(goodStageDir, "src"), { recursive: true });
    if (existsSync(path.join(sourceDir, "package-lock.json"))) {
      cpSync(path.join(sourceDir, "package-lock.json"), path.join(goodStageDir, "package-lock.json"));
    }

    const pkg = JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8"));
    pkg.version = nextPatchVersion(WONREMOTE_APP_VERSION);
    writeStagedAppVersion(goodStageDir, pkg.version);
    writeFileSync(path.join(goodStageDir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
    writeFileSync(path.join(goodStageDir, "update_marker.txt"), "GOOD_UPDATE_SUCCESS", "utf8");
    
    execFileSync("tar", ["-a", "-cf", goodUpdatePath, "-C", goodStageDir, "."]);
    const goodZip = readFileSync(goodUpdatePath);
    goodChecksum = createHash("sha256").update(goodZip).digest("hex");

    // 2. Bad Update Package (designed to trigger boot crash)
    cpSync(path.join(sourceDir, "src"), path.join(badStageDir, "src"), { recursive: true });
    if (existsSync(path.join(sourceDir, "package-lock.json"))) {
      cpSync(path.join(sourceDir, "package-lock.json"), path.join(badStageDir, "package-lock.json"));
    }
    writeFileSync(path.join(badStageDir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
    writeStagedAppVersion(badStageDir, pkg.version);
    writeFileSync(path.join(badStageDir, "crash.txt"), "TRIGGER_CRASH", "utf8");
    
    execFileSync("tar", ["-a", "-cf", badUpdatePath, "-C", badStageDir, "."]);
    const badZip = readFileSync(badUpdatePath);
    badBinaryChecksum = createHash("sha256").update(badZip).digest("hex");

    console.log(`[API Server] Generated update zips. Good Checksum: ${goodChecksum}, Bad Checksum: ${badBinaryChecksum}`);
  } catch (e) {
    console.error("[API Server] Failed to prepare update zip files:", e);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function resolveUpdateArtifactDir(): string {
  const configuredDir = process.env.WONREMOTE_UPDATE_ARTIFACT_DIR?.trim();
  const artifactDir = configuredDir
    ? path.resolve(configuredDir)
    : path.join(
        os.tmpdir(),
        "WonRemote",
        "update-artifacts",
        createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12),
      );
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

function resolveUpdateSourceDir(): string {
  return path.resolve(process.env.WONREMOTE_APP_DIR?.trim() || process.cwd());
}

async function loadProductionUpdateMetadata(): Promise<ProductionUpdateMetadata | null> {
  const publicKeyPem = process.env.WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY?.trim();
  const manifestFile = process.env.WONREMOTE_UPDATE_MANIFEST_FILE?.trim();
  if (manifestFile) {
    try {
      return parseProductionUpdateManifest(JSON.parse(readFileSync(path.resolve(manifestFile), "utf8")), {
        publicKeyPem: publicKeyPem || undefined,
      });
    } catch (error) {
      console.error("[API Server] Failed to read production update manifest file:", error);
      return null;
    }
  }

  const manifestUrl = process.env.WONREMOTE_UPDATE_MANIFEST_URL?.trim() || DEFAULT_UPDATE_MANIFEST_URL;
  if (process.env.NODE_ENV === "test" && !process.env.WONREMOTE_UPDATE_MANIFEST_URL?.trim()) {
    return null;
  }
  if (process.env.NODE_ENV !== "test" && !publicKeyPem) {
    console.error("[API Server] WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY is required for production update manifests.");
    return null;
  }

  try {
    const separator = manifestUrl.includes("?") ? "&" : "?";
    const manifestResponse = await fetch(`${manifestUrl}${separator}nocache=${Date.now()}`);
    if (!manifestResponse.ok) {
      console.error(`[API Server] Production update manifest fetch failed: HTTP ${manifestResponse.status}`);
      return null;
    }
    return parseProductionUpdateManifest(await manifestResponse.json(), {
      publicKeyPem: publicKeyPem || undefined,
    });
  } catch (error) {
    console.error("[API Server] Failed to fetch production update manifest:", error);
    return null;
  }
}

prepareUpdateFiles();

const DEFAULT_UPDATE_MANIFEST_URL =
  "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/wonremote-update-manifest.json";


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
    setCorsHeaders(request, response);

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
      const device = state.devices.find((item) => item.id === result.session.deviceId);
      if (!device) {
        throw new Error("Agent 장비 등록 결과를 확인할 수 없습니다.");
      }
      const opened = await openConnectedSession(state, device);
      writeJson(response, 200, {
        devices: state.devices,
        session: opened.session,
        inputLog: opened.inputLog,
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
    const device = resolveDeviceStatuses(state.devices, nowIso(state), state.offlineAfterMs).find(
      (item) => item.id === deviceId,
    );
    if (!device) {
      writeJson(response, 404, { error: "장비를 찾을 수 없습니다." });
      return;
    }

    if (device.status !== "online") {
      writeJson(response, 409, { error: "온라인 상태의 Agent만 접속할 수 있습니다." });
      return;
    }

    const opened = await openConnectedSession(state, device);
    writeJson(response, 200, {
      session: opened.session,
      inputLog: opened.inputLog,
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

    const device = resolveDeviceStatuses(state.devices, nowIso(state), state.offlineAfterMs).find(
      (item) => item.connectionCode === code,
    );
    if (!device) {
      writeJson(response, 404, { error: "해당 접속 코드를 가진 장비를 찾을 수 없습니다." });
      return;
    }

    if (device.status !== "online") {
      writeJson(response, 409, { error: "온라인 상태의 Agent만 접속할 수 있습니다." });
      return;
    }

    const opened = await openConnectedSession(state, device);
    writeJson(response, 200, {
      session: opened.session,
      inputLog: opened.inputLog,
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

      const session = state.sessions.get(sessionId);
      if (session?.state !== "connected") {
        writeJson(response, 409, { error: "접속 승인 전에는 입력 이벤트를 전송할 수 없습니다." });
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
      enqueueAgentCommand(state, session.deviceId, action);
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

  // Backdoor route to set update mode for E2E testing
  if (request.method === "POST" && url.pathname === "/api/test/set-update-mode") {
    if (process.env.NODE_ENV !== "test") {
      writeJson(response, 403, { error: "Forbidden: Only allowed in test environment" });
      return;
    }
    const body = await readJson<{ mode?: "none" | "good" | "bad_checksum" | "bad_binary" }>(request);
    if (body.mode) {
      testUpdateMode = body.mode;
      console.log(`[API Server] Test update mode updated to: ${testUpdateMode}`);
    }
    writeJson(response, 200, { ok: true, currentMode: testUpdateMode });
    return;
  }

  // 2. GET /api/update/check
  if (request.method === "GET" && url.pathname === "/api/update/check") {
    const isNone = testUpdateMode === "none";
    let latestVersion = WONREMOTE_APP_VERSION;
    
    if (isNone) {
      const productionUpdate = await loadProductionUpdateMetadata();
      if (productionUpdate) {
        writeJson(response, 200, productionUpdate);
        return;
      } else {
        latestVersion = WONREMOTE_APP_VERSION;
      }
    } else {
      latestVersion = nextPatchVersion(WONREMOTE_APP_VERSION);
    }
    
    const badChecksum = testUpdateMode === "bad_checksum";
    const badBinary = testUpdateMode === "bad_binary";

    let checksum = goodChecksum;
    let downloadUrl = "http://127.0.0.1:8787/api/update/download";

    if (badChecksum) {
      checksum = "invalid_checksum_for_rollback_test";
    } else if (badBinary) {
      checksum = badBinaryChecksum;
      downloadUrl = "http://127.0.0.1:8787/api/update/download?type=bad";
    }

    writeJson(response, 200, {
      latestVersion,
      forceUpdate: false,
      checksum,
      downloadUrl
    });
    return;
  }

  // GET /api/update/download
  if (request.method === "GET" && url.pathname === "/api/update/download") {
    const isBad = url.searchParams.get("type") === "bad";
    const filePath = isBad ? badUpdatePath : goodUpdatePath;
    const filename = path.basename(filePath);
    
    try {
      const data = readFileSync(filePath);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename=${filename}`
      });
      response.end(data);
    } catch (e) {
      writeJson(response, 404, { error: "Update file not found" });
    }
    return;
  }



  // POST /api/update/execute
  if (request.method === "POST" && url.pathname === "/api/update/execute") {
    if (process.env.NODE_ENV !== "test") {
      writeJson(response, 403, { error: "Forbidden: Only allowed in test environment" });
      return;
    }
    const body = await readJson<{ installerPath?: string }>(request);
    const installerPath = String(body.installerPath ?? "").trim();
    if (!installerPath) {
      writeJson(response, 400, { error: "Installer path is required" });
      return;
    }

    const baseDir = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const expectedPath = path.resolve(baseDir, "WonRemote", "update_install.bat");
    const resolvedPath = path.resolve(installerPath);

    if (resolvedPath !== expectedPath) {
      writeJson(response, 400, { error: "Forbidden installer path" });
      return;
    }

    try {
      console.log(`[API Server] Spawning installer from API Server: ${resolvedPath}`);
      const instProcess = spawn("cmd.exe", ["/c", resolvedPath], {
        detached: true,
        stdio: "ignore",
      });
      instProcess.unref();
      writeJson(response, 200, { ok: true });
    } catch (e) {
      writeJson(response, 500, { error: (e as Error).message });
    }
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
      if (!requireConnectedSession(state, response, sessionId)) {
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
      if (!requireConnectedSession(state, response, sessionId)) {
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
      if (!requireConnectedSession(state, response, sessionId)) {
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
      if (!requireConnectedSession(state, response, sessionId)) {
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
      if (!requireConnectedSession(state, response, sessionId)) {
        return;
      }
      const body = await readJson<{
        filename?: string;
        fileData?: string;
        transferId?: string;
        chunkIndex?: number;
        totalChunks?: number;
        totalBytes?: number;
        isLast?: boolean;
      }>(request);
      const filename = String(body.filename ?? "").trim();
      const fileData = String(body.fileData ?? "");
      const declaredTotalBytes = typeof body.totalBytes === "number" ? Math.max(0, Math.trunc(body.totalBytes)) : undefined;

      if (!filename || !fileData) {
        writeJson(response, 400, { error: "파일명 또는 파일 데이터가 없습니다." });
        return;
      }

      if (fileData.length > 15 * 1024 * 1024) {
        writeJson(response, 400, { error: "File chunk payload is too large." });
        return;
      }

      if ((declaredTotalBytes ?? Math.floor((fileData.length * 3) / 4)) > REMOTE_FILE_MAX_BYTES) {
        writeJson(response, 400, { error: `파일 크기는 ${remoteFileLimitLabel()}를 초과할 수 없습니다.` });
        return;
      }

      const files = state.sessionFiles.get(sessionId) ?? [];
      const newFile: TransferredFile = {
        id: `file-${files.length + 1}-${Date.now()}`,
        filename,
        fileData,
        transferId: body.transferId ? String(body.transferId) : undefined,
        chunkIndex: typeof body.chunkIndex === "number" ? Math.max(0, Math.trunc(body.chunkIndex)) : undefined,
        totalChunks: typeof body.totalChunks === "number" ? Math.max(1, Math.trunc(body.totalChunks)) : undefined,
        totalBytes: declaredTotalBytes,
        isLast: typeof body.isLast === "boolean" ? body.isLast : undefined,
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
      if (!requireConnectedSession(state, response, sessionId)) {
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
      if (!requireConnectedSession(state, response, sessionId)) {
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
      if (!requireConnectedSession(state, response, sessionId)) {
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

async function openConnectedSession(
  state: ApiState,
  device: ManagedDevice,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  const session: RemoteSession = {
    id: `session-${device.id}`,
    deviceId: device.id,
    state: "connected",
    startedAt: nowIso(state),
  };
  const inputLog = [`${new Date().toLocaleTimeString()} 세션 연결 완료`];

  state.sessions.set(session.id, session);
  state.inputLogs.set(session.id, inputLog);
  enqueueAgentCommand(state, session.deviceId, "start-stream");

  await state.historyStore.addHistoryEntry({
    id: `hist-${session.id}-${Date.now()}`,
    deviceId: device.id,
    storeName: device.storeName,
    deviceName: device.deviceName,
    startedAt: nowIso(state),
    status: "success",
  });

  return { session, inputLog };
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

function requireConnectedSession(
  state: ApiState,
  response: ServerResponse,
  sessionId: string,
): RemoteSession | null {
  const session = state.sessions.get(sessionId);
  if (!session) {
    writeJson(response, 404, { error: "세션을 찾을 수 없습니다." });
    return null;
  }
  if (session.state !== "connected") {
    writeJson(response, 409, { error: "접속 승인 전에는 세션 데이터를 전송할 수 없습니다." });
    return null;
  }
  return session;
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

function setCorsHeaders(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  const allowedOrigin =
    typeof origin === "string" && isAllowedLocalViewerOrigin(origin) ? origin : "http://127.0.0.1:5173";

  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function isAllowedLocalViewerOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      Number(url.port) >= 1 &&
      Number(url.port) <= 65535
    );
  } catch {
    return false;
  }
}
