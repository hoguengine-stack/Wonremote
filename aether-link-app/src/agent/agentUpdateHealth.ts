import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AgentHealthIdentity {
  registeredDeviceId?: string;
  installId: string;
}

export function createAgentHealthReporter(options: {
  baseDir: string;
  version: string;
  onHealthy?: () => void;
  writeReceipt?: (file: string, data: string) => Promise<void>;
}) {
  const startedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
  const receiptPath = path.join(options.baseDir, "WonRemote", "agent-online.json");
  const writeReceipt = options.writeReceipt ?? (async (file, data) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, data, "utf8");
    await rename(temporary, file);
    await writeFile(path.join(path.dirname(file), ".update_success"), "SUCCESS", "utf8");
  });
  let attempts = 0;
  let reported = false;
  let pending: Promise<void> | undefined;
  let acceptedHeartbeat: {
    acceptedAt: string;
    deviceId: string;
    installId: string;
  } | undefined;
  let commandReceiver: {
    deviceId: string;
    installId: string;
    readyAt: string;
  } | undefined;
  let commandChallenge: {
    action: string;
    deviceId: string;
    id: string;
    installId: string;
    queued: boolean;
  } | undefined;
  let commandRoundTrip: {
    deviceId: string;
    installId: string;
    verifiedAt: string;
  } | undefined;

  const tryReport = (): Promise<void> => {
    if (reported || attempts >= 3 || !acceptedHeartbeat || !commandReceiver || !commandRoundTrip ||
        acceptedHeartbeat.deviceId !== commandReceiver.deviceId ||
        acceptedHeartbeat.installId !== commandReceiver.installId ||
        acceptedHeartbeat.deviceId !== commandRoundTrip.deviceId ||
        acceptedHeartbeat.installId !== commandRoundTrip.installId) {
      return Promise.resolve();
    }
    if (pending) return pending;
    attempts++;
    const heartbeat = acceptedHeartbeat;
    const receiver = commandReceiver;
    const roundTrip = commandRoundTrip;
    const challenge = commandChallenge!;
    pending = Promise.resolve().then(() => writeReceipt(receiptPath, JSON.stringify({
      schemaVersion: 3,
      version: options.version,
      deviceId: heartbeat.deviceId,
      installId: heartbeat.installId,
      pid: process.pid,
      executablePath: process.execPath,
      startedAt,
      acceptedAt: heartbeat.acceptedAt,
      commandReceiverReadyAt: receiver.readyAt,
      commandRoundTripAt: roundTrip.verifiedAt,
      commandChallengeId: challenge.id,
    }))).then(() => {
      reported = true;
      options.onHealthy?.();
    }).finally(() => { pending = undefined; });
    return pending;
  };

  // Readiness is availability evidence, never authorization to execute an update.
  return {
    takeCommandChallenge(config: AgentHealthIdentity): string | null {
      if (!config.registeredDeviceId || reported || commandRoundTrip) return null;
      if (!commandChallenge) {
        const id = randomUUID();
        commandChallenge = {
          action: `agent-health-check ${id}`,
          deviceId: config.registeredDeviceId,
          id,
          installId: config.installId,
          queued: false,
        };
      }
      if (commandChallenge.deviceId !== config.registeredDeviceId ||
          commandChallenge.installId !== config.installId || commandChallenge.queued) {
        return null;
      }
      commandChallenge.queued = true;
      return commandChallenge.action;
    },
    commandChallengeFailed(action: string): void {
      if (commandChallenge?.action === action && !commandRoundTrip) {
        commandChallenge.queued = false;
      }
    },
    commandReceiverReady(config: AgentHealthIdentity): Promise<void> {
      if (!config.registeredDeviceId) return Promise.resolve();
      commandReceiver = {
        deviceId: config.registeredDeviceId,
        installId: config.installId,
        readyAt: new Date().toISOString(),
      };
      return tryReport();
    },
    commandReceiverUnavailable(): void {
      commandReceiver = undefined;
    },
    async commandRoundTripVerified(config: AgentHealthIdentity, action: string): Promise<boolean> {
      if (!config.registeredDeviceId || action !== commandChallenge?.action ||
          config.registeredDeviceId !== commandChallenge.deviceId ||
          config.installId !== commandChallenge.installId) {
        return false;
      }
      commandRoundTrip = {
        deviceId: config.registeredDeviceId,
        installId: config.installId,
        verifiedAt: new Date().toISOString(),
      };
      await tryReport();
      return true;
    },
    heartbeatAccepted(config: AgentHealthIdentity, acceptedDeviceId: string): Promise<void> {
      if (!config.registeredDeviceId || acceptedDeviceId !== config.registeredDeviceId) {
        return Promise.resolve();
      }
      acceptedHeartbeat = {
        acceptedAt: new Date().toISOString(),
        deviceId: acceptedDeviceId,
        installId: config.installId,
      };
      return tryReport();
    },
  };
}
