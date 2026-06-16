import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, cp, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bootstrapAgent } from "./agentBootstrap";
import { parseAgentConfigJson } from "./agentConfigJson";
import { parseSecurityCodeCommand, resolveInjectActions } from "./agentCommandActions";
import { pollAgentCommands, sendAgentHeartbeat } from "./agentClient";
import { waitForApiHealth } from "./agentHealth";
import {
  canRecoverMissingAgentRegistration,
  recoverMissingAgentRegistration,
} from "./agentRegistrationRecovery";
import { resolveAgentAppDir, resolveAgentPocPath } from "./agentPaths";
import { resolveAgentCredentials } from "./agentRuntime";
import {
  nextStreamCaptureBackend,
  nextStreamRestartDelayMs,
  resolveCommandPollIntervalMs,
  type StreamCaptureBackend,
} from "./agentStreamPolicy";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { computeSha256 } from "./checksum";
import { saveTransferredFileChunk } from "./fileTransferReceiver";
import { isSourceTreeUpdateTarget } from "./updateSafety";
import {
  downloadInstallerUpdate,
  prepareInstallerHandoff,
  isInstallerUpdateMetadata,
  type SafeInstallerUpdateMetadata,
} from "./productionInstallerUpdate";
import { loadProductionInstallerUpdateMetadata } from "./productionUpdateMetadata";
import {
  authenticateAgentWithFirebase,
  type AgentWebRtcTransport,
  fetchActiveFirebaseSessionsForAgent,
  fetchSessionDataWithFirebase,
  isAgentFirebaseEnabled,
  postChatWithFirebase,
  postClipboardWithFirebase,
  postFileTransferReceiptWithFirebase,
  postSessionTilesWithFirebase,
  registerAgentFirstRunWithFirebase,
  startAgentWebRtcTransportWithFirebase,
} from "../firebase/agentFirebase";
import type {
  AgentBootstrapDeps,
  AgentCredentials,
  AgentLocalConfig,
} from "./agentBootstrap";
import type {
  AgentControlDiagnostics,
  AgentFirstRunResult,
  AgentStreamDiagnostics,
  DeviceDisplayInfo,
  FileTransferReceipt,
} from "../domain/types";
import { spawn, execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import { fileURLToPath } from "node:url";



const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
async function execFileHidden(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    windowsHide: true,
  } as any) as any;
  return {
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}
async function execHidden(command: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(command, {
    encoding: "utf8",
    windowsHide: true,
  } as any) as any;
  return {
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_APP_DIR = path.resolve(__dirname, "..", "..");
const AGENT_APP_DIR = resolveAgentAppDir(process.env, DEFAULT_APP_DIR);
const POC_PATH = resolveAgentPocPath(process.env, AGENT_APP_DIR);

const API_BASE_URL = process.env.WONREMOTE_API_URL ?? "http://127.0.0.1:8787";
const HEARTBEAT_INTERVAL_MS = Number(process.env.WONREMOTE_AGENT_HEARTBEAT_MS ?? 10_000);
const COMMAND_POLL_INTERVAL_MS = resolveCommandPollIntervalMs(process.env);
const USE_FIREBASE = isAgentFirebaseEnabled(process.env);

let streamProcess: any = null;
let streamDesired = false;
let streamRestartTimer: any = null;
let streamFailureCount = 0;
let streamBackend: StreamCaptureBackend = "dxgi";
let streamGeneration = 0;
let webRtcTransport: AgentWebRtcTransport | null = null;
let currentOutputIndex = 0;
let currentLoopSleepMs = 33;
let streamRestartCount = 0;
let lastStreamFrameAt: string | undefined;
let lastStreamError: string | undefined;
let streamTransport: AgentStreamDiagnostics["transport"] = "none";
const pressedKeys = new Set<string>();
let displayCache: { loadedAtMs: number; displays: DeviceDisplayInfo[] } | null = null;

let isApprovalPending = false;
let isSessionActive = false;
let sessionPollIntervalId: any = null;
let isCommandPollInFlight = false;


function startStreaming(
  deviceId: string,
  outputIndex = 0,
  loopSleepMs = 33,
  backend: StreamCaptureBackend = streamBackend,
) {
  streamDesired = true;
  streamGeneration += 1;
  const generation = streamGeneration;
  streamBackend = backend;
  currentOutputIndex = outputIndex;
  currentLoopSleepMs = loopSleepMs;
  streamTransport = USE_FIREBASE ? "firestore-fallback" : "local-api";
  if (streamRestartTimer) {
    clearTimeout(streamRestartTimer);
    streamRestartTimer = null;
  }
  if (streamProcess) {
    streamProcess.kill();
  }

  // Data polling must stay alive even if the capture backend falls back or exits.
  startSessionPolling(deviceId);

  const pocPath = POC_PATH;
  const sessionId = `session-${deviceId}`;
  if (USE_FIREBASE) {
    void startAgentWebRtcTransportWithFirebase(sessionId)
      .then(async (transport) => {
        if (!transport || generation !== streamGeneration) {
          await transport?.close();
          return;
        }
        await webRtcTransport?.close();
        webRtcTransport = transport;
        console.log("[WebRTC] Agent tile data channel transport is ready.");
      })
      .catch((error) => {
        console.warn(`[WebRTC] Agent transport unavailable: ${error instanceof Error ? error.message : error}`);
      });
  }
  
  const env = {
    ...process.env,
    ...(backend === "gdi" ? { WONREMOTE_CAPTURE_BACKEND: "gdi" } : {}),
  };
  console.log(`Starting capture stream from: ${pocPath} (monitor: ${outputIndex}, sleep: ${loopSleepMs}ms, backend: ${backend})`);
  const child = spawn(pocPath, ["--mode", "stream", "--loop-sleep-ms", String(loopSleepMs), "--output-index", String(outputIndex)], {
    env,
    windowsHide: true,
  });
  streamProcess = child;

  const rl = readline.createInterface({
    input: child.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    try {
      const data = JSON.parse(line);
      if (data.type === "frame") {
        streamFailureCount = 0;
        lastStreamFrameAt = new Date().toISOString();
        lastStreamError = undefined;
        if (USE_FIREBASE && webRtcTransport?.sendFrame({ tiles: data.tiles, width: data.width, height: data.height })) {
          streamTransport = "webrtc";
        } else if (USE_FIREBASE) {
          streamTransport = "firestore-fallback";
          await postSessionTilesWithFirebase(sessionId, {
            tiles: data.tiles,
            width: data.width,
            height: data.height,
          });
        } else if (!USE_FIREBASE) {
          streamTransport = "local-api";
          await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/tiles`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tiles: data.tiles, width: data.width, height: data.height }),
          });
        }
      }
    } catch (e) {
      // ignore
    }
  });

  let streamStderrBuffer = "";
  let streamStderrText = "";
  const flushStreamLogLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/error|failed|denied|HRESULT|실패|거부/i.test(trimmed)) {
      lastStreamError = trimmed.slice(0, 500);
      console.error(`[POC Stream Error] ${trimmed}`);
    } else {
      console.log(`[POC Stream] ${trimmed}`);
    }
  };

  child.stderr.on("data", (data: any) => {
    const chunk = data.toString();
    streamStderrText += chunk;
    streamStderrBuffer += chunk;
    const lines = streamStderrBuffer.split(/\r?\n/);
    streamStderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      flushStreamLogLine(line);
    }
  });

  child.on("close", (code: number) => {
    const finalStderr = streamStderrText + streamStderrBuffer;
    flushStreamLogLine(streamStderrBuffer);
    streamStderrBuffer = "";
    console.log(`Capture stream process exited with code ${code}`);
    if (streamProcess === child) {
      streamProcess = null;
    }
    if (streamDesired && generation === streamGeneration) {
      const nextBackend = nextStreamCaptureBackend(streamBackend, finalStderr);
      const nextSleep = nextBackend === "gdi" ? Math.max(loopSleepMs, 125) : loopSleepMs;
      const delayMs = nextStreamRestartDelayMs(streamFailureCount);
      streamFailureCount += 1;
      streamRestartCount += 1;
      streamBackend = nextBackend;
      if (!lastStreamError && finalStderr.trim()) {
        lastStreamError = finalStderr.trim().slice(0, 500);
      }
      console.log(`Capture stream will restart in ${delayMs}ms (backend: ${nextBackend}, sleep: ${nextSleep}ms).`);
      streamRestartTimer = setTimeout(() => {
        streamRestartTimer = null;
        startStreaming(deviceId, outputIndex, nextSleep, nextBackend);
      }, delayMs);
    }
  });
}

function startSessionPolling(deviceId: string) {
  if (sessionPollIntervalId) {
    clearInterval(sessionPollIntervalId);
  }
  isSessionActive = true;
  sessionPollIntervalId = setInterval(() => {
    void pollSessionData(deviceId);
  }, 1500);
}

function stopSessionPolling() {
  streamDesired = false;
  streamGeneration += 1;
  streamFailureCount = 0;
  if (streamRestartTimer) {
    clearTimeout(streamRestartTimer);
    streamRestartTimer = null;
  }
  void webRtcTransport?.close();
  webRtcTransport = null;
  streamTransport = "none";
  isSessionActive = false;
  if (sessionPollIntervalId) {
    clearInterval(sessionPollIntervalId);
    sessionPollIntervalId = null;
  }
}

async function pollSessionData(deviceId: string) {
  const sessionId = `session-${deviceId}`;
  try {
    if (USE_FIREBASE) {
      const sessionData = await fetchSessionDataWithFirebase(sessionId);
      for (const msg of sessionData.messages) {
        if (msg.sender === "viewer") {
          if (msg.message === "__AUDIO_BEEP_SIGNAL__") {
            console.log("[Audio] Viewer beep signal received.");
          } else {
            console.log(`[Chat] Viewer: ${msg.message}`);
          }
        }
      }
      for (const item of sessionData.clipboards) {
        if (item.sender === "viewer") {
          await setClipboardText(item.text);
          console.log("[Clipboard] Viewer text injected into the agent clipboard.");
        }
      }
      for (const file of sessionData.files) {
        await saveTransferredFileAndReport(sessionId, file);
      }
      return;
    }

    // 1. Chat Polling
    const chatRes = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/chat`);
    if (chatRes.ok) {
      const chatData: any = await chatRes.json();
      if (chatData.messages && chatData.messages.length > 0) {
        for (const msg of chatData.messages) {
          if (msg.sender === "viewer") {
            if (msg.message === "__AUDIO_BEEP_SIGNAL__") {
              console.log("[오디오 수신] 뷰어가 오디오 비프 시그널을 수신했습니다. (시뮬레이션)");
            } else {
              console.log(`[채팅] 뷰어: ${msg.message}`);
            }
          }
        }
      }
    }

    // 2. Clipboard Polling
    const clipRes = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/clipboard`);
    if (clipRes.ok) {
      const clipData: any = await clipRes.json();
      if (clipData.clipboards && clipData.clipboards.length > 0) {
        for (const item of clipData.clipboards) {
          if (item.sender === "viewer") {
            console.log(`[클립보드 수신] 텍스트: ${item.text}`);
            const base64Text = Buffer.from(item.text).toString("base64");
            const psCmd = `powershell -NoProfile -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Text}')) | Set-Clipboard"`;
            exec(psCmd, { windowsHide: true }, (err) => {
              if (err) {
                console.error("[클립보드 주입 실패]", err.message);
              } else {
                console.log("[클립보드 주입 완료] 시스템 클립보드에 주입되었습니다.");
              }
            });
          }
        }
      }
    }

    // 3. File Polling
    const fileRes = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/files`);
    if (fileRes.ok) {
      const fileData: any = await fileRes.json();
      if (fileData.files && fileData.files.length > 0) {
        for (const file of fileData.files) {
          await saveTransferredFileAndReport(sessionId, file);
        }
      }
    }
  } catch (error) {
    // Session 404 ignore
  }
}

async function saveTransferredFileAndReport(sessionId: string, file: any): Promise<void> {
  try {
    const result = await saveTransferredFileChunk(file, process.env);
    console.log(
      `[File ${result.status}] ${result.filename} ${result.receivedChunks}/${result.totalChunks} chunks (${result.receivedBytes} bytes)`,
    );
    if (result.transferId) {
      await postFileTransferReceipt(sessionId, {
        transferId: result.transferId,
        filename: result.filename,
        status: result.status === "complete" ? "received" : "partial",
        receivedChunks: result.receivedChunks,
        totalChunks: result.totalChunks,
        receivedBytes: result.receivedBytes,
        savedPath: result.status === "complete" ? result.targetPath : undefined,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[File Transfer Failed] ${String(file?.filename ?? "unknown")}: ${message}`);
    if (typeof file?.transferId === "string") {
      await postFileTransferReceipt(sessionId, {
        transferId: file.transferId,
        filename: String(file.filename ?? ""),
        status: "failed",
        receivedChunks: Number.isInteger(file.chunkIndex) ? Number(file.chunkIndex) : 0,
        totalChunks: Number.isInteger(file.totalChunks) ? Number(file.totalChunks) : 0,
        error: message,
      });
    }
  }
}

async function postFileTransferReceipt(
  sessionId: string,
  receipt: Omit<FileTransferReceipt, "updatedAt">,
): Promise<void> {
  if (USE_FIREBASE) {
    await postFileTransferReceiptWithFirebase(sessionId, receipt);
    return;
  }

  await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/file-receipts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(receipt),
  });
}


async function main() {
  try {
    const baseDir = process.env.APPDATA ?? process.cwd();
    const wonRemoteDir = path.join(baseDir, "WonRemote");
    await mkdir(wonRemoteDir, { recursive: true });
    await writeFile(path.join(wonRemoteDir, "agent.pid"), String(process.pid), "utf8");
  } catch (err) {
    console.error("Failed to write agent.pid:", err);
  }

  const crashFile = path.join(process.cwd(), "crash.txt");
  try {
    await access(crashFile);
    console.error("[CRITICAL] Simulated boot crash detected via crash.txt!");
    await rm(crashFile, { force: true });
    process.exit(1);
  } catch (e) {
    // proceed
  }

  if (process.argv.includes("--install")) {
    await handleRegistryInstall();
    return;
  }
  if (process.argv.includes("--uninstall")) {
    await handleRegistryUninstall();
    return;
  }

  console.log("[Status] Connecting");
  if (!USE_FIREBASE) {
    let apiHealthy = await waitForApiHealth({ apiBaseUrl: API_BASE_URL });

    if (!apiHealthy) {
      if (process.argv.includes("--watch")) {
        console.log("[Agent] Waiting for API Server to become healthy...");
        while (!apiHealthy) {
          console.log("[Status] Connecting");
          apiHealthy = await waitForApiHealth({ apiBaseUrl: API_BASE_URL, attempts: 5, intervalMs: 1000 });
          if (!apiHealthy) {
            console.log("[Agent ERROR] API Server is still down. Retrying in 5 seconds...");
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      } else {
        console.log("[Status] Offline");
        console.error("[Agent ERROR] API Server did not become healthy within 15 seconds. Exiting.");
        process.exit(1);
      }
    }
  } else {
    console.log("[Agent] Firebase mode enabled. Skipping local API health gate.");
  }

  console.log("[Status] Online");

  const configPath = getAgentConfigPath();

  const result = await bootstrapAgent({
    createInstallId: () => `agent-${randomUUID().slice(0, 8)}`,
    nowIso: () => new Date().toISOString(),
    promptCredentials: () => resolveAgentCredentials(process.env, promptCredentials),
    readConfig: () => readAgentConfig(configPath),
    registerFirstRun,
    writeConfig: (config) => writeAgentConfig(configPath, config),
  } satisfies AgentBootstrapDeps);

  let activeConfig = result.config;

  if (result.status === "already_registered") {
    console.log(`Agent already registered: ${result.config.registeredDeviceId}`);
    console.log(`Config: ${configPath}`);
  } else {
    console.log(`Agent registered: ${result.device.deviceName}`);
    console.log(`Device ID: ${result.device.id}`);
    console.log(`Config: ${configPath}`);
  }

  // Check version updates on start
  await ensureFirebaseAgentAuth(activeConfig);
  await checkUpdate(activeConfig);

  try {
    activeConfig = await sendHeartbeatWithRecovery(activeConfig);
    await ensureActiveFirebaseSessionRecovery(activeConfig);
  } catch (error: any) {
    if (error.status === 404) {
      await handleUnregisteredDevice();
    }
    console.log("[Status] Connecting");
    console.error(error instanceof Error ? error.message : error);
  }

  const baseDir = process.env.APPDATA ?? process.cwd();
  const wonRemoteDir = path.join(baseDir, "WonRemote");
  const successMarker = path.join(wonRemoteDir, ".update_success");
  try {
    await writeFile(successMarker, "SUCCESS");
  } catch (e) {}

  try {
    await pollCommands(activeConfig);
  } catch (error: any) {
    let recovered = false;
    if (error.status === 404) {
      const recoveredConfig = await recoverConfigAfterMissingDevice(activeConfig);
      if (recoveredConfig) {
        activeConfig = recoveredConfig;
        await pollCommands(activeConfig);
        recovered = true;
      } else {
        await handleUnregisteredDevice();
      }
    }
    if (!recovered) {
      console.log("[Status] Connecting");
      console.error(error instanceof Error ? error.message : error);
    }
  }


  // Setup CLI interactive input for chatting, clipboard sharing, and audio beep signals
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return;

    if (isApprovalPending) {
      const sessionId = `session-${activeConfig.registeredDeviceId}`;
      if (text.toLowerCase() === "y" || text.toLowerCase() === "yes") {
        isApprovalPending = false;
        console.log("접속 요청을 승인했습니다. 세션을 기동합니다.");
        await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved: true })
        });
        isSessionActive = true;
      } else if (text.toLowerCase() === "n" || text.toLowerCase() === "no") {
        isApprovalPending = false;
        console.log("접속 요청을 거절했습니다.");
        await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved: false })
        });
      } else {
        console.log("Y 또는 N을 입력해주세요.");
      }
      return;
    }

    if (text.startsWith("chat ")) {
      const msg = text.slice(5).trim();
      if (msg && activeConfig.registeredDeviceId) {
        const sessionId = `session-${activeConfig.registeredDeviceId}`;
        if (USE_FIREBASE) {
          await postChatWithFirebase(sessionId, { message: msg, sender: "agent" });
        } else {
          await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: msg, sender: "agent" })
          });
        }
        console.log(`[보낸 채팅] 나: ${msg}`);
      }
    } else if (text.startsWith("clipboard ")) {
      const clip = text.slice(10);
      if (activeConfig.registeredDeviceId) {
        const sessionId = `session-${activeConfig.registeredDeviceId}`;
        if (USE_FIREBASE) {
          await postClipboardWithFirebase(sessionId, { text: clip, sender: "agent" });
        } else {
          await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/clipboard`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: clip, sender: "agent" })
          });
        }
        console.log(`[보낸 클립보드] 클립보드 텍스트를 전송했습니다.`);
      }
    } else if (text === "audio") {
      if (activeConfig.registeredDeviceId) {
        const sessionId = `session-${activeConfig.registeredDeviceId}`;
        if (USE_FIREBASE) {
          await postChatWithFirebase(sessionId, { message: "__AUDIO_BEEP_SIGNAL__", sender: "agent" });
        } else {
          await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "__AUDIO_BEEP_SIGNAL__", sender: "agent" })
          });
        }
        console.log("[보낸 오디오] 사운드 비프 시그널 전송.");
      }
    } else {
      console.log("사용 가능한 명령: chat <내용>, clipboard <내용>, audio (오디오 시그널 전송)");
    }
  });

  if (process.argv.includes("--watch")) {
    console.log(`Heartbeat interval: ${HEARTBEAT_INTERVAL_MS}ms`);
    console.log(`Command poll interval: ${COMMAND_POLL_INTERVAL_MS}ms`);
    setInterval(() => {
      void runAgentTick(activeConfig).then((nextConfig) => {
        activeConfig = nextConfig;
      });
    }, HEARTBEAT_INTERVAL_MS);
    setInterval(() => {
      void runCommandPollTick(activeConfig).then((nextConfig) => {
        activeConfig = nextConfig;
      });
    }, COMMAND_POLL_INTERVAL_MS);
  }
}

let isUpdating = false;

async function checkUpdate(config: AgentLocalConfig) {
  if (isUpdating) return;
  isUpdating = true;
  const currentVersion = config.version ?? WONREMOTE_APP_VERSION;
  try {
    const data = await loadUpdateCheckData();
    if (!data) {
      isUpdating = false;
      return;
    }

    if (data.latestVersion && isHigherVersion(data.latestVersion, currentVersion)) {
      if (isInstallerUpdateMetadata(data)) {
        await handoffToProductionInstallerUpdate(data);
        return;
      }

      const appDir = AGENT_APP_DIR;
      if (!isSourceTreeUpdateTarget(appDir)) {
        console.log(
          `[WonRemote Agent] Update ${data.latestVersion} detected, but source-tree updater is disabled for packaged resources: ${appDir}`,
        );
        isUpdating = false;
        return;
      }

      console.log(`\n[WonRemote Agent] 새로운 업데이트가 발견되었습니다! (최신: ${data.latestVersion} / 현재: ${currentVersion})`);
      console.log(`다운로드 경로: ${data.downloadUrl}`);

      const downloadRes = await fetch(data.downloadUrl);
      if (!downloadRes.ok) {
        throw new Error("다운로드 응답 오류");
      }

      const arrayBuf = await downloadRes.arrayBuffer();
      const zipBuffer = Buffer.from(arrayBuf);

      // Compute checksum
      const computedHash = computeSha256(zipBuffer);
      if (data.checksum && computedHash !== data.checksum) {
        console.error(`\n[체크섬 오류] 다운로드된 파일의 해시가 일치하지 않습니다. (기대: ${data.checksum} / 계산: ${computedHash})`);
        isUpdating = false;
        return;
      }
      console.log("\n[체크섬 검증 완료] 다운로드된 파일의 무결성이 확인되었습니다.");

      // ProgressBar simulation
      for (let pct = 0; pct <= 100; pct += 25) {
        const width = 20;
        const completed = Math.round((pct / 100) * width);
        const bar = "=".repeat(completed) + " ".repeat(width - completed);
        process.stdout.write(`\r업데이트 다운로드 중: [${bar}] ${pct}%`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      process.stdout.write("\n");

      // Save zip to temp path
      const baseDir = process.env.APPDATA ?? process.cwd();
      const tempUpdateDir = path.join(baseDir, "WonRemote", "temp_update");
      await rm(tempUpdateDir, { recursive: true, force: true });
      await mkdir(tempUpdateDir, { recursive: true });
      
      const zipPath = path.join(tempUpdateDir, "update.zip");
      await writeFile(zipPath, zipBuffer);

      // Extract zip using PowerShell Expand-Archive (native)
      const extractDest = path.join(tempUpdateDir, "extracted");
      await mkdir(extractDest, { recursive: true });

      console.log("업데이트 압축 파일 해제 중...");
      const extractPsCmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDest}' -Force"`;
      await execHidden(extractPsCmd);

      // Backup current files
      console.log("기존 실행 파일 백업 중...");
      const backupDir = path.join(baseDir, "WonRemote", "backup");
      await rm(backupDir, { recursive: true, force: true });
      await mkdir(backupDir, { recursive: true });

      const configPath = getAgentConfigPath();
      try {
        await cp(path.join(appDir, "src"), path.join(backupDir, "src"), { recursive: true });
        await cp(path.join(appDir, "package.json"), path.join(backupDir, "package.json"));
        await cp(path.join(appDir, "package-lock.json"), path.join(backupDir, "package-lock.json")).catch(() => {});
        await cp(configPath, path.join(backupDir, "agent-config.json"));
      } catch (e) {
        console.error("백업 오류:", e);
      }

      // Update configuration version locally
      config.version = data.latestVersion;
      await writeAgentConfig(configPath, config);

      // Create update_install.bat installer
      const installerPath = path.join(baseDir, "WonRemote", "update_install.bat");
      const logFilePath = path.join(baseDir, "WonRemote", "installer.log");

      const agentId = process.env.WONREMOTE_AGENT_ID ?? "1234567890";
      const agentPassword = process.env.WONREMOTE_AGENT_PASSWORD ?? "1234";
      const heartbeatMs = process.env.WONREMOTE_AGENT_HEARTBEAT_MS ?? "1000";

const installerContent = `@echo off
set "APPDATA=${baseDir}"
set "WONREMOTE_API_URL=${API_BASE_URL}"
set "WONREMOTE_AGENT_ID=${agentId}"
set "WONREMOTE_AGENT_PASSWORD=${agentPassword}"
set "WONREMOTE_AGENT_HEARTBEAT_MS=${heartbeatMs}"
set "WONREMOTE_APP_DIR=${appDir}"
set "WONREMOTE_POC_PATH=${POC_PATH}"
set "WONREMOTE_AGENT_CONFIG=${configPath}"

echo [Installer] Starting installation log... > "${logFilePath}"
echo [Installer] Waiting for Agent CLI to terminate... >> "${logFilePath}"
ping -n 3 127.0.0.1 > nul

echo [Installer] Copying update files to ${appDir}... >> "${logFilePath}"
xcopy /y /e /s "${path.join(tempUpdateDir, "extracted")}\\*" "${appDir}" >> "${logFilePath}" 2>&1

echo [Installer] Deleting success marker... >> "${logFilePath}"
del "${path.join(baseDir, "WonRemote", ".update_success")}" /f /q >> "${logFilePath}" 2>&1

echo [Installer] Starting new Agent version... >> "${logFilePath}"
cd /d "${appDir}"
start "" cmd /c "npm run agent:watch"

echo [Installer] Waiting 10 seconds to verify boot... >> "${logFilePath}"
ping -n 11 127.0.0.1 > nul

if exist "${path.join(baseDir, "WonRemote", ".update_success")}" (
    echo [Installer] Update verification successful! >> "${logFilePath}"
    rd /s /q "${tempUpdateDir}" >> "${logFilePath}" 2>&1
    rd /s /q "${backupDir}" >> "${logFilePath}" 2>&1
    exit /b 0
) else (
    echo [Installer] Boot verification FAILED! Rolling back... >> "${logFilePath}"
    xcopy /y /e /s "${backupDir}\\*" "${appDir}" >> "${logFilePath}" 2>&1
    copy /y "${path.join(backupDir, "agent-config.json")}" "${configPath}" >> "${logFilePath}" 2>&1
    echo [Installer] Restarting backup version... >> "${logFilePath}"
    start "" cmd /c "npm run agent:watch"
    rd /s /q "${tempUpdateDir}" >> "${logFilePath}" 2>&1
    exit /b 1
)
`;
      await writeFile(installerPath, installerContent, "utf8");

      console.log("업데이트 인스톨러 기동 중...");
      try {
        const execRes = await fetch(`${API_BASE_URL}/api/update/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ installerPath }),
        });
        if (!execRes.ok) {
          throw new Error("인스톨러 원격 실행 요청 실패");
        }
      } catch (err) {
        console.error("[인스톨러 기동 오류]:", err);
        const instProcess = spawn("cmd.exe", ["/c", installerPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          creationFlags: 0x08000000
        } as any) as any;
        instProcess.unref();
      }

      // Stop current processes and exit
      if (streamProcess) {
        streamProcess.kill();
        streamProcess = null;
      }
      
      console.log("[WonRemote Agent] 인스톨러로 전환하며 에이전트를 종료합니다.");
      await new Promise((resolve) => setTimeout(resolve, 500));
      process.exit(0);
    } else {
      isUpdating = false;
    }
  } catch (e) {
    console.error("[업데이트 실패]:", e instanceof Error ? e.message : e);
    isUpdating = false;
  }
}

async function loadUpdateCheckData(): Promise<any | null> {
  if (USE_FIREBASE) {
    return loadProductionInstallerUpdateMetadata(process.env);
  }

  const res = await fetch(`${API_BASE_URL}/api/update/check`);
  if (!res.ok) {
    return null;
  }
  return res.json();
}

async function handoffToProductionInstallerUpdate(data: SafeInstallerUpdateMetadata): Promise<void> {
  const baseDir = process.env.APPDATA ?? process.cwd();
  const download = await downloadInstallerUpdate(data, { baseDir });
  const handoff = await prepareInstallerHandoff(download, { baseDir });
  const { installerArgs, installerPath } = download;
  console.log(`[WonRemote Agent] Verified installer update downloaded: ${installerPath}`);
  console.log(`[WonRemote Agent] Launching installer with args: ${installerArgs.join(" ")}`);
  console.log(`[WonRemote Agent] Installer handoff script: ${handoff.scriptPath}`);
  console.log(`[WonRemote Agent] Installer handoff log: ${handoff.logPath}`);

  const installerProcess = spawn(handoff.command, handoff.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    creationFlags: handoff.creationFlags,
  } as any);
  installerProcess.unref();

  if (streamProcess) {
    streamProcess.kill();
    streamProcess = null;
  }

  console.log("[WonRemote Agent] Handed off to production installer and exiting current Agent.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
}


function isHigherVersion(latest: string, current: string): boolean {
  const lParts = latest.split(".").map(Number);
  const cParts = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const lVal = lParts[i] ?? 0;
    const cVal = cParts[i] ?? 0;
    if (lVal > cVal) return true;
    if (lVal < cVal) return false;
  }
  return false;
}

async function handleUnregisteredDevice() {
  console.log("[Status] Offline");
  console.log("[Error] Agent unregistered: Device not found on server.");
  const configPath = getAgentConfigPath();
  try {
    const fs = await import("node:fs/promises");
    await fs.rm(configPath, { force: true });
    console.log("Locally stored agent-config.json has been removed.");
  } catch (e) {
    console.error("Failed to delete agent-config.json:", e);
  }
  process.exit(1);
}

async function runAgentTick(config: AgentLocalConfig): Promise<AgentLocalConfig> {
  let activeConfig = config;
  try {
    activeConfig = await sendHeartbeatWithRecovery(activeConfig);
    await ensureActiveFirebaseSessionRecovery(activeConfig);
    await pollCommands(activeConfig);
    await checkUpdate(activeConfig);
    console.log("[Status] Online");
  } catch (error: any) {
    if (error.status === 404) {
      const recoveredConfig = await recoverConfigAfterMissingDevice(activeConfig);
      if (recoveredConfig) {
        activeConfig = recoveredConfig;
        await sendHeartbeat(activeConfig);
        await ensureActiveFirebaseSessionRecovery(activeConfig);
        console.log("[Status] Online");
        return activeConfig;
      } else {
        await handleUnregisteredDevice();
      }
    }
    console.log("[Status] Connecting");
    console.error(error instanceof Error ? error.message : error);
  }
  return activeConfig;
}

async function runCommandPollTick(config: AgentLocalConfig): Promise<AgentLocalConfig> {
  if (isCommandPollInFlight) {
    return config;
  }
  isCommandPollInFlight = true;
  try {
    await pollCommands(config);
    return config;
  } catch (error: any) {
    if (error.status === 404) {
      const recoveredConfig = await recoverConfigAfterMissingDevice(config);
      if (!recoveredConfig) {
        await handleUnregisteredDevice();
        return config;
      }
      return recoveredConfig;
    } else {
      console.error(error instanceof Error ? error.message : error);
      return config;
    }
  } finally {
    isCommandPollInFlight = false;
  }
}

async function ensureActiveFirebaseSessionRecovery(config: AgentLocalConfig): Promise<void> {
  if (!USE_FIREBASE || !config.registeredDeviceId || streamDesired) {
    return;
  }
  const sessions = await fetchActiveFirebaseSessionsForAgent({
    deviceId: config.registeredDeviceId,
    installId: config.installId,
  });
  if (sessions.length === 0) {
    return;
  }
  console.log(`[Agent] Recovering active remote session after restart: ${sessions[0].id}`);
  startStreaming(config.registeredDeviceId, currentOutputIndex, currentLoopSleepMs);
}


async function sendHeartbeatWithRecovery(config: AgentLocalConfig): Promise<AgentLocalConfig> {
  try {
    await sendHeartbeat(config);
    return config;
  } catch (error: any) {
    if (error.status !== 404) {
      throw error;
    }
    const recoveredConfig = await recoverConfigAfterMissingDevice(config);
    if (!recoveredConfig) {
      throw error;
    }
    let activeConfig = recoveredConfig;
    await sendHeartbeat(activeConfig);
    return activeConfig;
  }
}

async function recoverConfigAfterMissingDevice(config: AgentLocalConfig): Promise<AgentLocalConfig | null> {
  if (!USE_FIREBASE || !canRecoverMissingAgentRegistration(config)) {
    return null;
  }

  console.log("[Agent] Firebase device document is missing. Re-registering from local config.");
  return recoverMissingAgentRegistration(config, {
    nowIso: () => new Date().toISOString(),
    registerFirstRun,
    writeConfig: (nextConfig) => writeAgentConfig(getAgentConfigPath(), nextConfig),
  });
}

async function ensureFirebaseAgentAuth(config: AgentLocalConfig): Promise<void> {
  if (!USE_FIREBASE) {
    return;
  }
  if (!config.businessNumber) {
    throw new Error("Firebase Agent auth requires businessNumber in local config.");
  }
  await authenticateAgentWithFirebase({
    businessNumber: config.businessNumber,
    password: "1234",
  });
}

async function sendHeartbeat(config: AgentLocalConfig): Promise<void> {
  if (!config.registeredDeviceId) {
    throw new Error("Agent 등록 장비 ID가 없습니다.");
  }

  const displays = await discoverDisplays();
  const macAddresses = discoverMacAddresses();
  const controlDiagnostics = await discoverControlDiagnostics();
  const streamDiagnostics = buildStreamDiagnostics();
  const result = await sendAgentHeartbeat({
    apiBaseUrl: API_BASE_URL,
    deviceId: config.registeredDeviceId,
    installId: config.installId,
    version: config.version,
    displays,
    activeDisplayIndex: currentOutputIndex,
    macAddresses,
    controlDiagnostics,
    streamDiagnostics,
  });
  console.log(`Heartbeat accepted: ${result.device.id}`);
}

async function pollCommands(config: AgentLocalConfig): Promise<void> {
  if (!config.registeredDeviceId) {
    throw new Error("Agent 등록 장비 ID가 없습니다.");
  }

  const result = await pollAgentCommands({
    apiBaseUrl: API_BASE_URL,
    deviceId: config.registeredDeviceId,
    installId: config.installId,
  });
  
  const pocPath = POC_PATH;

  for (const command of result.commands) {
    console.log(`Command received: ${command.action}`);
    try {
      if (command.action === "request-approval") {
        console.log("\n==============================================");
        console.log("[보안 경고] 뷰어로부터 원격 접속 승인 요청이 도착했습니다.");
        console.log("승인하시겠습니까? (Y/N) 입력을 대기합니다...");
        console.log("==============================================");
        isApprovalPending = true;
      } else if (command.action === "start-stream") {
        console.log("Starting capture stream due to start-stream command");
        startStreaming(config.registeredDeviceId!, currentOutputIndex, currentLoopSleepMs);
      } else if (command.action === "stop-stream") {
        stopSessionPolling();
        if (streamProcess) {
          console.log("Stopping capture stream due to stop-stream command");
          streamProcess.kill();
          streamProcess = null;
        }
      } else if (command.action.startsWith("switch-monitor ")) {
        const parts = command.action.split(" ");
        const nextIndex = parseInt(parts[1], 10);
        if (!isNaN(nextIndex)) {
          currentOutputIndex = nextIndex;
          console.log(`Switching monitor to output-index: ${currentOutputIndex}`);
          startStreaming(config.registeredDeviceId!, currentOutputIndex, currentLoopSleepMs);
        }
      } else if (command.action.startsWith("set-sleep ")) {
        const parts = command.action.split(" ");
        const nextSleep = parseInt(parts[1], 10);
        if (!isNaN(nextSleep) && nextSleep !== currentLoopSleepMs) {
          currentLoopSleepMs = nextSleep;
          console.log(`Adjusting stream loop sleep to: ${currentLoopSleepMs}ms`);
          startStreaming(config.registeredDeviceId!, currentOutputIndex, currentLoopSleepMs);
        }
      } else if (command.action === "clipboard-request") {
        const text = await getClipboardText();
        const sessionId = `session-${config.registeredDeviceId}`;
        if (USE_FIREBASE) {
          await postClipboardWithFirebase(sessionId, { text, sender: "agent" });
        } else {
          await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/clipboard`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, sender: "agent" }),
          });
        }
        console.log("[Clipboard] Current agent clipboard sent to viewer");
      } else if (command.action.startsWith("security-code ")) {
        const securityCode = parseSecurityCodeCommand(command.action);
        if (!securityCode) {
          console.warn(`[Security Connect] Invalid security-code command: ${command.action}`);
          continue;
        }
        await showSecurityCode(securityCode.code);
      } else if (command.action === "ping-color-change") {
        if (streamProcess) {
          console.log("Injecting color marker signal to streamer process stdin");
          streamProcess.stdin.write("ping-color-change\n");
        }
        const { stdout } = await execFileHidden(pocPath, [
          "--mode",
          "inject-input",
          "--action",
          command.action,
        ]);
        console.log(`[Inject Success] ${stdout.trim()}`);
      } else {
        const resolved = resolveInjectActions(command.action, pressedKeys);
        if (resolved.type === "pasteText") {
          await setClipboardText(resolved.text);
        }

        for (const action of resolved.actions) {
          const { stdout } = await execFileHidden(pocPath, [
            "--mode",
            "inject-input",
            "--action",
            action,
          ]);
          console.log(`[Inject Success] ${stdout.trim()}`);
        }
      }
    } catch (error) {
      console.error(`[Inject Failed] ${error instanceof Error ? error.message : error}`);
    }
  }

}

async function discoverDisplays(): Promise<DeviceDisplayInfo[] | undefined> {
  const now = Date.now();
  if (displayCache && now - displayCache.loadedAtMs < 60_000) {
    return displayCache.displays;
  }

  try {
    const { stdout } = await execFileHidden(POC_PATH, ["--mode", "list-displays"]);
    const parsed = JSON.parse(stdout) as Array<{
      index?: unknown;
      name?: unknown;
      width?: unknown;
      height?: unknown;
      primary?: unknown;
    }>;
    const displays = parsed
      .filter(
        (display) =>
          Number.isFinite(Number(display.index)) &&
          Number(display.width) > 0 &&
          Number(display.height) > 0,
      )
      .map((display) => ({
        index: Number(display.index),
        name: String(display.name ?? `Display ${display.index}`),
        width: Number(display.width),
        height: Number(display.height),
        primary: Boolean(display.primary),
      }));

    displayCache = { loadedAtMs: now, displays };
    return displays;
  } catch (error) {
    console.warn(`[Agent] Display inventory unavailable: ${error instanceof Error ? error.message : error}`);
    return displayCache?.displays;
  }
}

function discoverMacAddresses(): string[] | undefined {
  const macAddresses = Array.from(
    new Set(
      Object.values(networkInterfaces())
        .flatMap((items) => items ?? [])
        .map((item) => item.mac.trim().toUpperCase().replace(/-/g, ":"))
        .filter((mac) => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac))
        .filter((mac) => mac !== "00:00:00:00:00:00"),
    ),
  );
  return macAddresses.length > 0 ? macAddresses : undefined;
}

async function discoverControlDiagnostics(): Promise<AgentControlDiagnostics | undefined> {
  try {
    const { stdout } = await execFileHidden(POC_PATH, ["--mode", "diagnostics"]);
    const parsed = JSON.parse(stdout) as {
      elevated?: unknown;
      integrity_level?: unknown;
      win32_error_code?: unknown;
      win32_error_message?: unknown;
    };
    return {
      elevated: typeof parsed.elevated === "boolean" ? parsed.elevated : undefined,
      integrityLevel: typeof parsed.integrity_level === "string" ? parsed.integrity_level : undefined,
      win32ErrorCode: typeof parsed.win32_error_code === "number" ? parsed.win32_error_code : undefined,
      win32ErrorMessage: typeof parsed.win32_error_message === "string" ? parsed.win32_error_message : undefined,
    };
  } catch (error) {
    console.warn(`[Agent] Control diagnostics unavailable: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

function buildStreamDiagnostics(): AgentStreamDiagnostics {
  return {
    backend: streamBackend,
    desired: streamDesired,
    running: Boolean(streamProcess),
    restartCount: streamRestartCount,
    loopSleepMs: currentLoopSleepMs,
    outputIndex: currentOutputIndex,
    lastFrameAt: lastStreamFrameAt,
    lastError: lastStreamError,
    transport: streamTransport,
  };
}

async function setClipboardText(text: string): Promise<void> {
  const base64Text = Buffer.from(text).toString("base64");
  const psCmd = `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Text}')) | Set-Clipboard`;
  await execFileHidden("powershell", ["-NoProfile", "-Command", psCmd]);
}

async function showSecurityCode(code: string): Promise<void> {
  console.log(`[Security Connect] Code shown on agent PC: ${code}`);
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const escapedCode = code.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName PresentationFramework",
    `[System.Windows.MessageBox]::Show('WonRemote 보안접속 코드: ${escapedCode}', 'WonRemote 보안접속') | Out-Null`,
  ].join("; ");

  execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true }, (error) => {
    if (error) {
      console.error(`[Security Connect] Failed to show code popup: ${error.message}`);
    }
  });
}

async function getClipboardText(): Promise<string> {
  const { stdout } = await execFileHidden("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]);
  return String(stdout ?? "").replace(/\r?\n$/, "");
}

async function promptCredentials(): Promise<AgentCredentials> {
  const rl = createInterface({ input, output });
  try {
    const businessNumber = await rl.question("Agent ID (business number): ");
    const password = await rl.question("Agent password: ");
    return {
      businessNumber,
      password,
    };
  } finally {
    rl.close();
  }
}

async function registerFirstRun(inputBody: {
  businessNumber: string;
  installId: string;
  password: string;
  version?: string;
}): Promise<AgentFirstRunResult> {
  if (USE_FIREBASE) {
    return registerAgentFirstRunWithFirebase(inputBody);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/agent/first-run`, {
      body: JSON.stringify(inputBody),
      headers: { "content-type": "application/json" },
      method: "POST",
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

async function readAgentConfig(configPath: string): Promise<AgentLocalConfig | null> {
  try {
    return parseAgentConfigJson(await readFile(configPath, "utf8"));
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function writeAgentConfig(configPath: string, config: AgentLocalConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getAgentConfigPath(): string {
  if (process.env.WONREMOTE_AGENT_CONFIG) {
    return process.env.WONREMOTE_AGENT_CONFIG;
  }

  const baseDir = process.env.APPDATA ?? process.cwd();
  return path.join(baseDir, "WonRemote", "agent-config.json");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function handleRegistryInstall() {
  if (process.env.WONREMOTE_ALLOW_HEADLESS_REGISTRY !== "1") {
    console.error(
      "agent:install is disabled. Use the installed Tauri app in --agent mode so the Agent runs with the tray icon and registers HKCU Run\\WonRemoteAgent.",
    );
    process.exit(1);
  }

  const agentPath = path.resolve(__filename);
  const commandToRun = `cmd /c node "${agentPath}" --watch`;
  // Production startup is owned by the Tauri --agent tray path. This opt-in CLI
  // key is only for local headless diagnostics and must not overwrite it.
  const psCommand = `New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WonRemoteAgentCLI" -PropertyType String -Value '${commandToRun}' -Force`;
  
  try {
    await execHidden(`powershell -NoProfile -Command "${psCommand}"`);
    console.log("WonRemote Agent가 윈도우 시작 프로그램에 성공적으로 등록되었습니다.");
    process.exit(0);
  } catch (error) {
    console.error("자동 실행 등록 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function handleRegistryUninstall() {
  if (process.env.WONREMOTE_ALLOW_HEADLESS_REGISTRY !== "1") {
    console.error(
      "agent:uninstall is disabled. Use the Tauri Agent tray menu Run at Startup toggle to remove HKCU Run\\WonRemoteAgent.",
    );
    process.exit(1);
  }

  const psCommand = `Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "WonRemoteAgentCLI" -ErrorAction SilentlyContinue`;
  
  try {
    await execHidden(`powershell -NoProfile -Command "${psCommand}"`);
    console.log("WonRemote Agent가 윈도우 시작 프로그램에서 제거되었습니다.");
    process.exit(0);
  } catch (error) {
    console.error("자동 실행 해제 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
