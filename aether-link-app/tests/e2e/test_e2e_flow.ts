import { spawn, execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceAppDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(sourceAppDir, "..");
const e2eRoot = path.join(os.tmpdir(), `wonremote-e2e-${process.pid}`);
const appDir = path.join(e2eRoot, "aether-link-app");
const appData = path.join(e2eRoot, "AppData", "Roaming");
const updateArtifactDir = path.join(e2eRoot, "update-artifacts");
const pocPath = path.join(repoRoot, "aether-link-poc", "target", "release", "wonremote-poc.exe");
const sourcePackageJson = JSON.parse(await fs.readFile(path.join(sourceAppDir, "package.json"), "utf8")) as {
  version: string;
};
const currentAppVersion = sourcePackageJson.version;

async function readAgentPid(): Promise<number | null> {
  const pidPath = path.join(appData, "WonRemote", "agent.pid");
  try {
    const content = await fs.readFile(pidPath, "utf8");
    const pid = parseInt(content.trim(), 10);
    if (!isNaN(pid)) return pid;
  } catch (e) {}
  return null;
}

// Check if a process is running on Windows
function isProcessRunning(pid: number): boolean {
  try {
    const stdout = execSync(`tasklist /FI "PID eq ${pid}"`, { stdio: "pipe" }).toString();
    return stdout.includes(String(pid));
  } catch (e) {
    return false;
  }
}

function killTree(pid: number) {
  try {
    console.log(`[Test Runner] Terminating process tree for PID: ${pid}`);
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
  } catch (e) {
    // Ignore if process already exited
  }
}

async function prepareFixtureApp() {
  await fs.rm(e2eRoot, { recursive: true, force: true });
  await fs.mkdir(appDir, { recursive: true });

  await fs.cp(path.join(sourceAppDir, "src"), path.join(appDir, "src"), { recursive: true });
  for (const filename of ["package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html"]) {
    await fs.copyFile(path.join(sourceAppDir, filename), path.join(appDir, filename));
  }

  await fs.symlink(path.join(sourceAppDir, "node_modules"), path.join(appDir, "node_modules"), "junction");
}

async function main() {
  console.log("=== Starting Multi-Phase E2E Flow & Auto-Update/Rollback Verification ===");

  // 1. Cleanup old processes (only on port 8787 and wonremote-poc.exe)
  console.log("Cleaning up old processes...");
  try {
    const netstat = execSync("netstat -ano | findstr :8787").toString();
    const lines = netstat.split("\n");
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length >= 5) {
        const pid = tokens[tokens.length - 1];
        if (pid && pid !== "0" && /^\d+$/.test(pid)) {
          killTree(parseInt(pid, 10));
          console.log(`Killed port 8787 process (PID: ${pid})`);
        }
      }
    }
  } catch (e) {}

  try {
    execSync("taskkill /F /IM wonremote-poc.exe 2>nul || exit 0", { shell: true });
    console.log("Killed wonremote-poc.exe processes");
  } catch (e) {}

  await prepareFixtureApp();
  console.log(`Prepared isolated fixture app: ${appDir}`);

  // 2. Remove configuration and history files for clean environment
  const configPath = path.join(appData, "WonRemote", "agent-config.json");
  const historyPath = path.join(appData, "WonRemote", "connection_history.json");
  const devicesPath = path.join(appData, "WonRemote", "devices.json");
  const downloadsDir = path.join(appData, "WonRemote", "Downloads");
  const wonRemoteDir = path.join(appData, "WonRemote");

  try {
    await fs.rm(configPath, { force: true });
    await fs.rm(historyPath, { force: true });
    await fs.rm(devicesPath, { force: true });
    await fs.rm(path.join(downloadsDir, "e2e_test.txt"), { force: true });
    await fs.rm(path.join(wonRemoteDir, "crash.txt"), { force: true });
    await fs.rm(path.join(wonRemoteDir, ".update_success"), { force: true });
    await fs.rm(path.join(wonRemoteDir, "agent.pid"), { force: true });
    await fs.rm(path.join(appDir, "crash.txt"), { force: true });
    await fs.rm(path.join(wonRemoteDir, "installer.log"), { force: true });
    console.log("Cleared old configs/histories/devices/downloads/markers/logs");
  } catch (e) {}

  // PIDs we need to track for final cleanup
  const pidsToCleanup = new Set<number>();

  // 3. Start API Server in test env with 2-second agent offline threshold
  console.log("Starting API Server...");
  const apiServer = spawn("npm", ["run", "api"], {
    cwd: appDir,
    shell: true,
    env: {
      ...process.env,
      APPDATA: appData,
      PORT: "8787",
      NODE_ENV: "test",
      WONREMOTE_AGENT_OFFLINE_MS: "2000",
      WONREMOTE_APP_DIR: appDir,
      WONREMOTE_UPDATE_ARTIFACT_DIR: updateArtifactDir,
    }
  });

  if (apiServer.pid) {
    pidsToCleanup.add(apiServer.pid);
  }

  apiServer.stdout.on("data", (data) => {
    console.log(`[API Server] ${data.toString().trim()}`);
  });
  apiServer.stderr.on("data", (data) => {
    console.error(`[API Server ERR] ${data.toString().trim()}`);
  });

  // Wait for API Server to be healthy
  async function waitPort(port: number, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          return true;
        }
      } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Port ${port} failed to start within ${timeoutMs}ms`);
  }

  await waitPort(8787);
  console.log("API Server is ready!");

  // Helpers to spawn and handle Agent CLI
  let agentProcess: any = null;
  let agentStdoutCollector = "";
  let resolveChecksumError: (() => void) | null = null;
  let resolveUpdateStart: (() => void) | null = null;

  function shouldPrintAgentLog(str: string): boolean {
    const trimmed = str.trim();
    if (!trimmed) return false;
    if (trimmed.includes("Heartbeat accepted")) return false;
    if (trimmed === "[Status] Online") return false;
    if (trimmed.includes("[Tile Merge Stats]")) return false;
    if (trimmed.includes("JPEG Encodes:")) return false;
    if (/^\d+\s*->/.test(trimmed)) return false;
    return true;
  }

  function spawnAgent() {
    console.log("[Test Runner] Spawning Agent CLI...");
    agentStdoutCollector = "";
    agentProcess = spawn("npm", ["run", "agent:watch"], {
      cwd: appDir,
      shell: true,
      env: {
        ...process.env,
        WONREMOTE_API_URL: "http://127.0.0.1:8787",
        WONREMOTE_AGENT_ID: "1234567890",
        WONREMOTE_AGENT_PASSWORD: "1234",
        WONREMOTE_AGENT_HEARTBEAT_MS: "1000",
        WONREMOTE_APP_DIR: appDir,
        WONREMOTE_POC_PATH: pocPath,
        APPDATA: appData,
        NODE_ENV: "test"
      }
    });

    if (agentProcess.pid) {
      pidsToCleanup.add(agentProcess.pid);
    }

    agentProcess.stdout.on("data", (data: any) => {
      const str = data.toString();
      agentStdoutCollector += str;
      if (shouldPrintAgentLog(str)) {
        console.log(`[Agent] ${str.trim()}`);
      }

      if (str.includes("체크섬 오류") && resolveChecksumError) {
        resolveChecksumError();
      }
      if (str.includes("인스톨러로 전환하며 에이전트를 종료합니다") && resolveUpdateStart) {
        resolveUpdateStart();
      }
    });

    agentProcess.stderr.on("data", (data: any) => {
      const str = data.toString();
      if (shouldPrintAgentLog(str)) {
        console.error(`[Agent ERR] ${str.trim()}`);
      }
      if (str.includes("체크섬 오류") && resolveChecksumError) {
        resolveChecksumError();
      }
    });
  }

  async function waitAgentOnline(expectedVersion: string, previousPid?: number, timeoutMs = 35000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const currentPid = await readAgentPid();
        if (currentPid && (!previousPid || (currentPid !== previousPid && isProcessRunning(currentPid)))) {
          const res = await fetch("http://127.0.0.1:8787/api/devices");
          if (res.ok) {
            const data = (await res.json()) as any;
            const dev = data.devices?.[0];
            if (dev && dev.status === "online" && dev.version === expectedVersion) {
              return dev;
            }
          }
        }
      } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    
    const logPath = path.join(wonRemoteDir, "installer.log");
    try {
      const logs = await fs.readFile(logPath, "utf8");
      console.error("--- Installer Log Output (on timeout) ---");
      console.error(logs);
      console.error("------------------------------------------");
    } catch(e) {
      console.error("Installer log not available:", (e as Error).message);
    }
    
    throw new Error(`Agent (expected version: ${expectedVersion}) did not come back online within ${timeoutMs}ms`);
  }

  // ----------------------------------------------------
  // Phase 1: Basic Connection & Data Channel Verification
  // ----------------------------------------------------
  console.log("\n================ PHASE 1: Basic Session Connection & Data sync ================");
  spawnAgent();

  console.log("Waiting for Agent heartbeat to register...");
  const initialDevice = await waitAgentOnline(currentAppVersion);
  const initialAgentPid = await readAgentPid();
  if (initialAgentPid) {
    pidsToCleanup.add(initialAgentPid);
    console.log(`[Test Runner] Tracked initial Agent PID from agent.pid: ${initialAgentPid}`);
  }

  const connectionCode = initialDevice.connectionCode;

  console.log("Requesting session connection from Viewer using code...");
  const connRes = await fetch("http://127.0.0.1:8787/api/sessions/connect-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionCode })
  });
  const connData = (await connRes.json()) as any;
  const sessionId = connData.session.id;
  if (connData.session.state !== "connected") {
    throw new Error(`Expected immediate connected session, got ${connData.session.state}`);
  }

  // Wait for session to connect
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Chat/Clipboard/File testing
  console.log("Exchanging Chat message...");
  await fetch(`http://127.0.0.1:8787/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hello E2E", sender: "viewer" })
  });
  agentProcess.stdin.write("chat Hello back\n");
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // File sync
  console.log("Uploading file from viewer...");
  const fileDataStr = Buffer.from("File content verification").toString("base64");
  await fetch(`http://127.0.0.1:8787/api/sessions/${sessionId}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "e2e_test.txt", fileData: fileDataStr })
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Verify file saved
  const savedFile = path.join(downloadsDir, "e2e_test.txt");
  const fileOk = await fs.access(savedFile).then(() => true).catch(() => false);
  console.log(`File sync status: ${fileOk}`);
  if (!fileOk) throw new Error("File sync failed");

  console.log("Closing active session...");
  await fetch(`http://127.0.0.1:8787/api/sessions/${sessionId}/close`, { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // ----------------------------------------------------
  // Phase 2: Checksum Failure Verification
  // ----------------------------------------------------
  console.log("\n================ PHASE 2: Checksum Failure Verification ================");

  console.log("Setting API Server to bad_checksum mode...");
  await fetch("http://127.0.0.1:8787/api/test/set-update-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "bad_checksum" })
  });

  console.log("Waiting for Agent CLI to detect bad checksum and reject it...");
  const checksumPromise = new Promise<void>((resolve) => {
    resolveChecksumError = resolve;
  });
  await checksumPromise;
  console.log("Agent rejected the update correctly owing to checksum mismatch!");

  // ----------------------------------------------------
  // Phase 3: Broken Binary Rollback Verification
  // ----------------------------------------------------
  console.log("\n================ PHASE 3: Broken Binary Rollback Verification ================");
  console.log("Setting API Server to bad_binary mode...");
  await fetch("http://127.0.0.1:8787/api/test/set-update-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "bad_binary" })
  });

  console.log("Waiting for Agent to trigger update downloader and exit...");
  const updateStartPromise = new Promise<void>((resolve) => {
    resolveUpdateStart = resolve;
  });
  await updateStartPromise;
  console.log("Agent shut down to install update. Waiting for rollback flow to execute...");

  // Reset update mode immediately to "none" to prevent the rolled-back agent from looping updates!
  console.log("Resetting API Server to none mode to allow rollback verification...");
  await fetch("http://127.0.0.1:8787/api/test/set-update-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "none" })
  });

  const rolledBackDevice = await waitAgentOnline(currentAppVersion, initialAgentPid || undefined);
  console.log(`Agent rolled back and is online! Version: ${rolledBackDevice.version}`);

  // Capture rolled back agent PID from agent.pid
  const rolledBackPid = await readAgentPid();
  if (rolledBackPid) {
    pidsToCleanup.add(rolledBackPid);
    console.log(`[Test Runner] Tracked rolled-back Agent PID: ${rolledBackPid}`);
  }

  // ----------------------------------------------------
  // Phase 4: Good Binary Successful Update Verification
  // ----------------------------------------------------
  console.log("\n================ PHASE 4: Good Binary Successful Update Verification ================");
  console.log("Setting API Server to good mode...");
  await fetch("http://127.0.0.1:8787/api/test/set-update-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "good" })
  });

  console.log("Waiting for Agent to download good zip, restart, and register as version 0.1.3...");
  const updatedDevice = await waitAgentOnline("0.1.3", rolledBackPid || undefined);
  console.log(`Agent successfully upgraded and registered as version: ${updatedDevice.version}`);

  // Capture updated agent PID from agent.pid
  const updatedPid = await readAgentPid();
  if (updatedPid) {
    pidsToCleanup.add(updatedPid);
    console.log(`[Test Runner] Tracked updated Agent PID: ${updatedPid}`);
  }

  // Confirm .update_success file exists
  const successFile = path.join(wonRemoteDir, ".update_success");
  const successOk = await fs.access(successFile).then(() => true).catch(() => false);
  console.log(`Success marker .update_success exists: ${successOk}`);

  console.log("\n=========================================================================");
  console.log("=== ALL E2E PHASES AND AUTO-UPDATE/ROLLBACK VERIFICATIONS COMPLETED! ===");
  console.log("=========================================================================");

  // Cleanup all spawned processes cleanly using tracked PIDs
  console.log("Cleaning up tracked processes...");
  for (const pid of pidsToCleanup) {
    killTree(pid);
  }

  try {
    execSync("taskkill /F /IM wonremote-poc.exe 2>nul || exit 0", { shell: true });
  } catch (e) {}

  await fs.rm(e2eRoot, { recursive: true, force: true });
  process.exit(0);
}

main().catch(async (err) => {
  console.error("E2E Verification Failed:", err);
  
  // Cleanup on failure
  try {
    const netstat = execSync("netstat -ano | findstr :8787").toString();
    const lines = netstat.split("\n");
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length >= 5) {
        const pid = tokens[tokens.length - 1];
          if (pid && pid !== "0" && /^\d+$/.test(pid)) {
          killTree(parseInt(pid, 10));
        }
      }
    }
  } catch (e) {}

  const latestPid = await readAgentPid();
  if (latestPid) {
    killTree(latestPid);
  }

  try {
    execSync("taskkill /F /IM wonremote-poc.exe 2>nul || exit 0", { shell: true });
  } catch (e) {}

  process.exit(1);
});
