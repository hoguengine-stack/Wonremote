import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, cp, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bootstrapAgent } from "./agentBootstrap";
import { pollAgentCommands, sendAgentHeartbeat } from "./agentClient";
import { waitForApiHealth } from "./agentHealth";
import { resolveAgentAppDir, resolveAgentPocPath } from "./agentPaths";
import { resolveAgentCredentials } from "./agentRuntime";
import { computeSha256 } from "./checksum";
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
const DEFAULT_APP_DIR = path.resolve(__dirname, "..", "..");
const AGENT_APP_DIR = resolveAgentAppDir(process.env, DEFAULT_APP_DIR);
const POC_PATH = resolveAgentPocPath(process.env, AGENT_APP_DIR);

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

  const pocPath = POC_PATH;
  
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
  try {
    const baseDir = process.env.APPDATA ?? process.cwd();
    const aetherLinkDir = path.join(baseDir, "AetherLink");
    await mkdir(aetherLinkDir, { recursive: true });
    await writeFile(path.join(aetherLinkDir, "agent.pid"), String(process.pid), "utf8");
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

  const apiHealthy = await waitForApiHealth({ apiBaseUrl: API_BASE_URL });

  if (!apiHealthy) {
    console.error("[Agent ERROR] API Server did not become healthy within 15 seconds. Exiting.");
    process.exit(1);
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
  await checkUpdate(result.config);

  await sendHeartbeat(result.config);

  const baseDir = process.env.APPDATA ?? process.cwd();
  const aetherLinkDir = path.join(baseDir, "AetherLink");
  const successMarker = path.join(aetherLinkDir, ".update_success");
  try {
    await writeFile(successMarker, "SUCCESS");
  } catch (e) {}

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

let isUpdating = false;

async function checkUpdate(config: AgentLocalConfig) {
  if (isUpdating) return;
  isUpdating = true;
  const currentVersion = config.version ?? "0.1.0";
  try {
    const res = await fetch(`${API_BASE_URL}/api/update/check`);
    if (!res.ok) {
      isUpdating = false;
      return;
    }
    const data: any = await res.json();
    if (data.latestVersion && isHigherVersion(data.latestVersion, currentVersion)) {
      console.log(`\n[AetherLink Agent] 새로운 업데이트가 발견되었습니다! (최신: ${data.latestVersion} / 현재: ${currentVersion})`);
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
      const tempUpdateDir = path.join(baseDir, "AetherLink", "temp_update");
      await rm(tempUpdateDir, { recursive: true, force: true });
      await mkdir(tempUpdateDir, { recursive: true });
      
      const zipPath = path.join(tempUpdateDir, "update.zip");
      await writeFile(zipPath, zipBuffer);

      // Extract zip using PowerShell Expand-Archive (native)
      const extractDest = path.join(tempUpdateDir, "extracted");
      await mkdir(extractDest, { recursive: true });

      console.log("업데이트 압축 파일 해제 중...");
      const extractPsCmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDest}' -Force"`;
      await execAsync(extractPsCmd);

      // Backup current files
      console.log("기존 실행 파일 백업 중...");
      const backupDir = path.join(baseDir, "AetherLink", "backup");
      await rm(backupDir, { recursive: true, force: true });
      await mkdir(backupDir, { recursive: true });

      const appDir = AGENT_APP_DIR;
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
      const installerPath = path.join(baseDir, "AetherLink", "update_install.bat");
      const logFilePath = path.join(baseDir, "AetherLink", "installer.log");

      const agentId = process.env.AETHER_LINK_AGENT_ID ?? "1234567890";
      const agentPassword = process.env.AETHER_LINK_AGENT_PASSWORD ?? "1234";
      const heartbeatMs = process.env.AETHER_LINK_AGENT_HEARTBEAT_MS ?? "1000";

      const installerContent = `@echo off
set "AETHER_LINK_API_URL=${API_BASE_URL}"
set "AETHER_LINK_AGENT_ID=${agentId}"
set "AETHER_LINK_AGENT_PASSWORD=${agentPassword}"
set "AETHER_LINK_AGENT_HEARTBEAT_MS=${heartbeatMs}"
set "AETHER_LINK_APP_DIR=${appDir}"
set "AETHER_LINK_POC_PATH=${POC_PATH}"

echo [Installer] Starting installation log... > "${logFilePath}"
echo [Installer] Waiting for Agent CLI to terminate... >> "${logFilePath}"
ping -n 3 127.0.0.1 > nul

echo [Installer] Copying update files to ${appDir}... >> "${logFilePath}"
xcopy /y /e /s "${path.join(tempUpdateDir, "extracted")}\\*" "${appDir}" >> "${logFilePath}" 2>&1

echo [Installer] Deleting success marker... >> "${logFilePath}"
del "${path.join(baseDir, "AetherLink", ".update_success")}" /f /q >> "${logFilePath}" 2>&1

echo [Installer] Starting new Agent version... >> "${logFilePath}"
cd /d "${appDir}"
start cmd /c "npm run agent:watch"

echo [Installer] Waiting 10 seconds to verify boot... >> "${logFilePath}"
ping -n 11 127.0.0.1 > nul

if exist "${path.join(baseDir, "AetherLink", ".update_success")}" (
    echo [Installer] Update verification successful! >> "${logFilePath}"
    rd /s /q "${tempUpdateDir}" >> "${logFilePath}" 2>&1
    rd /s /q "${backupDir}" >> "${logFilePath}" 2>&1
    exit /b 0
) else (
    echo [Installer] Boot verification FAILED! Rolling back... >> "${logFilePath}"
    xcopy /y /e /s "${backupDir}\\*" "${appDir}" >> "${logFilePath}" 2>&1
    copy /y "${path.join(backupDir, "agent-config.json")}" "${configPath}" >> "${logFilePath}" 2>&1
    echo [Installer] Restarting backup version... >> "${logFilePath}"
    start cmd /c "npm run agent:watch"
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
          creationFlags: 0x00000010
        } as any) as any;
        instProcess.unref();
      }

      // Stop current processes and exit
      if (streamProcess) {
        streamProcess.kill();
        streamProcess = null;
      }
      
      console.log("[AetherLink Agent] 인스톨러로 전환하며 에이전트를 종료합니다.");
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

async function runAgentTick(config: AgentLocalConfig): Promise<void> {
  try {
    await sendHeartbeat(config);
    await pollCommands(config);
    await checkUpdate(config);
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
    version: config.version,
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
