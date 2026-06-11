import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bootstrapAgent } from "./agentBootstrap";
import { pollAgentCommands, sendAgentHeartbeat } from "./agentClient";
import { resolveAgentCredentials } from "./agentRuntime";
import type {
  AgentBootstrapDeps,
  AgentCredentials,
  AgentLocalConfig,
} from "./agentBootstrap";
import type { AgentFirstRunResult } from "../domain/types";
import { spawn, execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE_URL = process.env.AETHER_LINK_API_URL ?? "http://127.0.0.1:8787";
const HEARTBEAT_INTERVAL_MS = Number(process.env.AETHER_LINK_AGENT_HEARTBEAT_MS ?? 10_000);

let streamProcess: any = null;
let currentOutputIndex = 0;
let currentLoopSleepMs = 33;

let isApprovalPending = false;
let isSessionActive = false;
let sessionPollIntervalId: any = null;


function startStreaming(deviceId: string, outputIndex = 0, loopSleepMs = 33) {
  if (streamProcess) {
    streamProcess.kill();
  }

  // Start Phase 3 data polling
  startSessionPolling(deviceId);

  const pocPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "aether-link-poc",
    "target",
    "release",
    "aether-link-poc.exe"
  );
  
  console.log(`Starting DXGI capture stream from: ${pocPath} (monitor: ${outputIndex}, sleep: ${loopSleepMs}ms)`);
  streamProcess = spawn(pocPath, ["--mode", "stream", "--loop-sleep-ms", String(loopSleepMs), "--output-index", String(outputIndex)]);

  const rl = readline.createInterface({
    input: streamProcess.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    try {
      const data = JSON.parse(line);
      if (data.type === "frame") {
        const sessionId = `session-${deviceId}`;
        await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/tiles`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tiles: data.tiles, width: data.width, height: data.height }),
        });
      }
    } catch (e) {
      // ignore
    }
  });

  streamProcess.stderr.on("data", (data: any) => {
    console.error(`[POC Stream Error] ${data.toString().trim()}`);
  });

  streamProcess.on("close", (code: number) => {
    console.log(`DXGI capture stream process exited with code ${code}`);
    stopSessionPolling();
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
  isSessionActive = false;
  if (sessionPollIntervalId) {
    clearInterval(sessionPollIntervalId);
    sessionPollIntervalId = null;
  }
}

async function pollSessionData(deviceId: string) {
  const sessionId = `session-${deviceId}`;
  try {
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
            exec(psCmd, (err) => {
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
          console.log(`[파일 전송 수신] 파일명: ${file.filename} (크기: ${Math.round(file.fileData.length * 0.75)} bytes)`);
          const downloadsDir = path.join(process.env.APPDATA ?? process.cwd(), "AetherLink", "Downloads");
          await mkdir(downloadsDir, { recursive: true });
          const targetPath = path.join(downloadsDir, file.filename);
          const buffer = Buffer.from(file.fileData, "base64");
          await writeFile(targetPath, buffer);
          console.log(`[파일 저장 완료] 경로: ${targetPath}`);
        }
      }
    }
  } catch (error) {
    // Session 404 ignore
  }
}


async function main() {
  if (process.argv.includes("--install")) {
    await handleRegistryInstall();
    return;
  }
  if (process.argv.includes("--uninstall")) {
    await handleRegistryUninstall();
    return;
  }

  const configPath = getAgentConfigPath();
  const result = await bootstrapAgent({
    createInstallId: () => `agent-${randomUUID().slice(0, 8)}`,
    nowIso: () => new Date().toISOString(),
    promptCredentials: () => resolveAgentCredentials(process.env, promptCredentials),
    readConfig: () => readAgentConfig(configPath),
    registerFirstRun,
    writeConfig: (config) => writeAgentConfig(configPath, config),
  } satisfies AgentBootstrapDeps);

  if (result.status === "already_registered") {
    console.log(`Agent already registered: ${result.config.registeredDeviceId}`);
    console.log(`Config: ${configPath}`);
  } else {
    console.log(`Agent registered: ${result.device.deviceName}`);
    console.log(`Device ID: ${result.device.id}`);
    console.log(`Config: ${configPath}`);
  }

  // Check version updates on start
  await checkUpdate();

  await sendHeartbeat(result.config);
  await pollCommands(result.config);

  // Setup CLI interactive input for chatting, clipboard sharing, and audio beep signals
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return;

    if (isApprovalPending) {
      const sessionId = `session-${result.config.registeredDeviceId}`;
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
      if (msg && result.config.registeredDeviceId) {
        const sessionId = `session-${result.config.registeredDeviceId}`;
        await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, sender: "agent" })
        });
        console.log(`[보낸 채팅] 나: ${msg}`);
      }
    } else if (text.startsWith("clipboard ")) {
      const clip = text.slice(10);
      if (result.config.registeredDeviceId) {
        const sessionId = `session-${result.config.registeredDeviceId}`;
        await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/clipboard`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: clip, sender: "agent" })
        });
        console.log(`[보낸 클립보드] 클립보드 텍스트를 전송했습니다.`);
      }
    } else if (text === "audio") {
      if (result.config.registeredDeviceId) {
        const sessionId = `session-${result.config.registeredDeviceId}`;
        await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "__AUDIO_BEEP_SIGNAL__", sender: "agent" })
        });
        console.log("[보낸 오디오] 사운드 비프 시그널 전송.");
      }
    } else {
      console.log("사용 가능한 명령: chat <내용>, clipboard <내용>, audio (오디오 시그널 전송)");
    }
  });

  if (process.argv.includes("--watch")) {
    console.log(`Heartbeat interval: ${HEARTBEAT_INTERVAL_MS}ms`);
    setInterval(() => {
      void runAgentTick(result.config);
    }, HEARTBEAT_INTERVAL_MS);
  }
}

async function checkUpdate() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/update/check`);
    if (res.ok) {
      const data: any = await res.json();
      console.log(`[업데이트 정보] 최신 버전: ${data.latestVersion} (현재: 0.1.0)`);
      if (data.latestVersion !== "0.1.0") {
        console.log(`[업데이트 안내] 새 버전을 다운로드할 수 있습니다: ${data.downloadUrl}`);
      }
    }
  } catch (e) {
    // ignore
  }
}


async function runAgentTick(config: AgentLocalConfig): Promise<void> {
  try {
    await sendHeartbeat(config);
    await pollCommands(config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

async function sendHeartbeat(config: AgentLocalConfig): Promise<void> {
  if (!config.registeredDeviceId) {
    throw new Error("Agent 등록 장비 ID가 없습니다.");
  }

  const result = await sendAgentHeartbeat({
    apiBaseUrl: API_BASE_URL,
    deviceId: config.registeredDeviceId,
    installId: config.installId,
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
  
  const pocPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "aether-link-poc",
    "target",
    "release",
    "aether-link-poc.exe"
  );

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
        console.log("Starting DXGI capture stream due to start-stream command");
        startStreaming(config.registeredDeviceId!, currentOutputIndex, currentLoopSleepMs);
      } else if (command.action === "stop-stream") {
        if (streamProcess) {
          console.log("Stopping DXGI capture stream due to stop-stream command");
          streamProcess.kill();
          streamProcess = null;
        }
        stopSessionPolling();
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
      } else if (command.action === "ping-color-change") {
        if (streamProcess) {
          console.log("Injecting color marker signal to streamer process stdin");
          streamProcess.stdin.write("ping-color-change\n");
        }
        const { stdout } = await execFileAsync(pocPath, [
          "--mode",
          "inject-input",
          "--action",
          command.action,
        ]);
        console.log(`[Inject Success] ${stdout.trim()}`);
      } else {
        const { stdout } = await execFileAsync(pocPath, [
          "--mode",
          "inject-input",
          "--action",
          command.action,
        ]);
        console.log(`[Inject Success] ${stdout.trim()}`);
      }
    } catch (error) {
      console.error(`[Inject Failed] ${error instanceof Error ? error.message : error}`);
    }
  }

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
}): Promise<AgentFirstRunResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/agent/first-run`, {
      body: JSON.stringify(inputBody),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new Error("AetherLink API 서버에 연결할 수 없습니다.");
  }

  const payload = (await response.json()) as AgentFirstRunResult & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "Agent 등록 실패");
  }
  return payload;
}

async function readAgentConfig(configPath: string): Promise<AgentLocalConfig | null> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as AgentLocalConfig;
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
  if (process.env.AETHER_LINK_AGENT_CONFIG) {
    return process.env.AETHER_LINK_AGENT_CONFIG;
  }

  const baseDir = process.env.APPDATA ?? process.cwd();
  return path.join(baseDir, "AetherLink", "agent-config.json");
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
  const agentPath = path.resolve(__filename);
  const commandToRun = `cmd /c node "${agentPath}" --watch`;
  const psCommand = `New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "AetherLinkAgent" -PropertyType String -Value '${commandToRun}' -Force`;
  
  try {
    await execAsync(`powershell -NoProfile -Command "${psCommand}"`);
    console.log("AetherLink Agent가 윈도우 시작 프로그램에 성공적으로 등록되었습니다.");
    process.exit(0);
  } catch (error) {
    console.error("자동 실행 등록 실패:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function handleRegistryUninstall() {
  const psCommand = `Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "AetherLinkAgent" -ErrorAction SilentlyContinue`;
  
  try {
    await execAsync(`powershell -NoProfile -Command "${psCommand}"`);
    console.log("AetherLink Agent가 윈도우 시작 프로그램에서 제거되었습니다.");
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
