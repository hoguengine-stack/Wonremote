import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import type {
  AgentCommand,
  AgentCommandPollResult,
  AgentFirstRunInput,
  AgentFirstRunResult,
  AgentHeartbeatInput,
  AgentHeartbeatResult,
  AgentUpdateTelemetry,
  ChatMessage,
  ClipboardData,
  FileTransferReceipt,
  TransferredFile,
} from "../domain/types";
import { requireTurnWhenRelayOnly, resolveRtcIceServers, shouldUseRelayOnly } from "../domain/rtcTransport";
import {
  formatWebRtcConnectionFailure,
  isTerminalWebRtcConnectionState,
  resolveWebRtcConnectTimeoutMs,
} from "../domain/webrtcStability";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { buildAgentAuthEmail, buildAgentAuthPassword } from "./firebaseIdentity";
import { buildFirestoreDevice, mapFirestoreDevice, mergeFirstRunDeviceDocument } from "./firestoreDevice";
import { getWonRemoteFirebaseServices } from "./firebaseServices";
import { throwExplainedFirebaseAuthError } from "./firebaseError";
import { bindAgentDataChannelStatus } from "./agentWebRtcStatus";
import {
  bindAgentControlMessages,
  bindAgentFileMessages,
  createAgentPeerConnection,
  dataChannelBufferedAmount,
  routeAgentDataChannel,
  sendFrameWithBackpressure,
  resolveWebRtcMaxBufferedAmount,
  resolveWebRtcMaxMessageBytes,
  type AgentDataChannelLike,
  type AgentDataChannelTaskQueue,
  type AgentPeerConnectionLike,
} from "./agentPeerConnection";
import {
  serializeWebRtcFileAck,
  type WebRtcFileAckMessage,
  type WebRtcFileChunkMessage,
} from "../domain/webrtcFileTransfer";
import {
  candidateMatchesNegotiation,
  parseAgentWebRtcOffer,
  rememberNegotiationAttempt,
} from "./agentWebRtcNegotiation";
import { safeAddDoc, safeBatchUpdate, safeSetDoc, safeUpdateDoc } from "./firestoreWrite";
import type { UpdateFleetRollout } from "../domain/updateFleetPolicy";
import type { DeviceUpdateRing } from "../domain/types";

type AgentFirebaseEnv = Record<string, string | undefined>;

export interface AgentWebRtcTransport {
  close: () => Promise<void>;
  getBufferedAmount: () => number;
  sendFrame: (
    frame: { tiles: any[]; width: number; height: number; sequence: number; keyframe: boolean },
    maxBufferedAmountOverride?: number,
  ) => "backpressure" | "sent" | "unavailable";
}

export interface AgentWebRtcTransportHandlers {
  onControl?: (action: string, isCurrentChannel: () => boolean) => void;
  onControlClosed?: () => void;
  onFileChunk?: (
    chunk: WebRtcFileChunkMessage,
    isCurrentChannel: () => boolean,
  ) => Promise<WebRtcFileAckMessage | null> | WebRtcFileAckMessage | null;
  onState?: (state: "open" | "closed" | "error", error?: string) => void;
}

export interface ActiveFirebaseSession {
  id: string;
  deviceId: string;
}

export function isAgentFirebaseEnabled(env: AgentFirebaseEnv = process.env): boolean {
  return resolveFirebaseConfig(env) !== null;
}

export function resolveAgentFrameMaxBufferedAmount(
  override: unknown,
  env: AgentFirebaseEnv = process.env,
): number {
  return typeof override === "number" && Number.isFinite(override) && override > 0
    ? override
    : resolveWebRtcMaxBufferedAmount(env);
}

export async function authenticateAgentWithFirebase(
  input: { businessNumber: string; password?: string },
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const services = getAgentFirebaseServices(env);
  const email = buildAgentAuthEmail(input.businessNumber);
  const authPassword = buildAgentAuthPassword(input.businessNumber, input.password ?? "1234");
  try {
    await signInWithEmailAndPassword(services.auth, email, authPassword);
  } catch (error) {
    throwExplainedFirebaseAuthError(error);
  }
}

export async function registerAgentFirstRunWithFirebase(
  input: AgentFirstRunInput,
  env: AgentFirebaseEnv = process.env,
): Promise<AgentFirstRunResult> {
  const services = getAgentFirebaseServices(env);
  const email = buildAgentAuthEmail(input.businessNumber);
  const authPassword = buildAgentAuthPassword(input.businessNumber, input.password);
  let credential;

  try {
    credential = await signInWithEmailAndPassword(services.auth, email, authPassword);
  } catch (error) {
    try {
      credential = await createUserWithEmailAndPassword(services.auth, email, authPassword);
    } catch (createError) {
      if (isFirebaseAuthCode(createError, "auth/email-already-in-use")) {
        credential = await signInWithEmailAndPassword(services.auth, email, authPassword);
      } else {
        throwExplainedFirebaseAuthError(createError);
      }
    }
    if (!credential) {
      throwExplainedFirebaseAuthError(error);
    }
  }

  const nowIso = new Date().toISOString();
  const device = buildFirestoreDevice({
    businessNumber: input.businessNumber,
    installId: input.installId,
    nowIso,
    ownerUid: credential.user.uid,
    version: input.version,
  });
  const deviceRef = doc(services.db, "devices", device.id);
  const previousDeviceId = input.previousDeviceId?.trim();
  const previousDeviceRef = previousDeviceId && previousDeviceId !== device.id
    ? doc(services.db, "devices", previousDeviceId)
    : null;
  let deviceDocument = device;

  await runTransaction(services.db, async (transaction) => {
    const existingSnapshot = await transaction.get(deviceRef);
    const previousSnapshot = previousDeviceRef ? await transaction.get(previousDeviceRef) : null;
    deviceDocument = mergeFirstRunDeviceDocument(
      device,
      existingSnapshot.exists() ? existingSnapshot.data() : undefined,
    );

    if (previousSnapshot?.exists()) {
      const previous = previousSnapshot.data() as Record<string, unknown>;
      if (canRetirePreviousDevice(previous, device, credential.user.uid, input.installId)) {
        const previousStoreName = typeof previous.storeName === "string" ? previous.storeName.trim() : "";
        if (deviceDocument.storeNameSource !== "user" && previous.storeNameSource === "user" && previousStoreName) {
          deviceDocument = {
            ...deviceDocument,
            storeName: previousStoreName,
            storeNameSource: "user",
          };
        }
        transaction.update(previousDeviceRef!, {
          deletedAt: serverTimestamp(),
          status: "offline",
          updatedAt: serverTimestamp(),
        });
      }
    }

    transaction.set(
      deviceRef,
      {
        ...deviceDocument,
        deletedAt: null,
        installId: input.installId,
        ownerUid: credential.user.uid,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });

  const resultDevice = mapFirestoreDevice(device.id, deviceDocument);
  return {
    devices: [resultDevice],
    device: resultDevice,
  };
}

function canRetirePreviousDevice(
  previous: Record<string, unknown>,
  device: { businessNumber: string },
  ownerUid: string,
  installId: string,
): boolean {
  return previous.ownerUid === ownerUid
    && typeof previous.businessNumber === "string"
    && previous.businessNumber.replace(/\D/g, "") === device.businessNumber.replace(/\D/g, "")
    && typeof previous.installId === "string"
    && previous.installId.trim() !== installId.trim()
    && (previous.deletedAt === undefined || previous.deletedAt === null);
}

export async function sendAgentHeartbeatWithFirebase(
  input: AgentHeartbeatInput,
  env: AgentFirebaseEnv = process.env,
): Promise<AgentHeartbeatResult> {
  const services = getAgentFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", input.deviceId);
  const nowIso = new Date().toISOString();
  try {
    // Firestore rules keep installId immutable; a mismatched Agent update is rejected there.
    await safeUpdateDoc(deviceRef, {
      activeDisplayIndex: input.activeDisplayIndex,
      displays: input.displays ?? [],
      installId: input.installId,
      lastSeenAt: nowIso,
      macAddresses: input.macAddresses ?? [],
      controlDiagnostics: input.controlDiagnostics ?? null,
      deletedAt: null,
      streamDiagnostics: input.streamDiagnostics ?? null,
      status: "online",
      updatedAt: serverTimestamp(),
      version: input.version,
      ...(input.updateTelemetry ? updateTelemetryDocument(input.updateTelemetry) : {}),
    });
  } catch (error) {
    if (isFirebaseNotFoundError(error)) {
      throwStatusError("Firebase device not found", 404);
    }
    throw error;
  }

  const device = mapFirestoreDevice(input.deviceId, {
    businessNumber: "",
    deviceNumber: "",
    deviceName: "",
    desktopName: "",
    storeName: "",
    lastSeenAt: nowIso,
    status: "online",
    version: input.version,
    activeDisplayIndex: input.activeDisplayIndex,
    displays: input.displays ?? [],
    macAddresses: input.macAddresses ?? [],
    controlDiagnostics: input.controlDiagnostics,
    streamDiagnostics: input.streamDiagnostics,
  });

  return {
    devices: [device],
    device,
  };
}

export async function reportAgentUpdateTelemetryWithFirebase(
  deviceId: string,
  telemetry: AgentUpdateTelemetry,
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const services = getAgentFirebaseServices(env);
  await safeUpdateDoc(doc(services.db, "devices", deviceId), {
    ...updateTelemetryDocument(telemetry),
    updatedAt: serverTimestamp(),
  });
}

export async function loadAgentUpdateRolloutWithFirebase(
  deviceId: string,
  env: AgentFirebaseEnv = process.env,
): Promise<{ rollout: UpdateFleetRollout; updatePaused: boolean; updateRing: DeviceUpdateRing } | null> {
  const services = getAgentFirebaseServices(env);
  const [deviceSnapshot, rolloutSnapshot] = await Promise.all([
    getDoc(doc(services.db, "devices", deviceId)),
    getDoc(doc(services.db, "configuration", "updateRollout")),
  ]);
  if (!deviceSnapshot.exists() || !rolloutSnapshot.exists()) return null;
  const device = deviceSnapshot.data() as Record<string, unknown>;
  const rollout = rolloutSnapshot.data() as Record<string, unknown>;
  const targetVersion = typeof rollout.targetVersion === "string" ? rollout.targetVersion.trim() : "";
  const stage = sanitizeUpdateRing(rollout.stage);
  if (!targetVersion || !stage) return null;
  return {
    rollout: {
      targetVersion,
      stage,
      paused: rollout.paused === true,
      percentage: typeof rollout.percentage === "number" ? rollout.percentage : 100,
    },
    updatePaused: device.updatePaused === true,
    updateRing: sanitizeUpdateRing(device.updateRing) ?? "general",
  };
}

function updateTelemetryDocument(telemetry: AgentUpdateTelemetry): Record<string, unknown> {
  return {
    updateCurrentVersion: telemetry.currentVersion,
    updateError: telemetry.error?.trim() || null,
    updateProgress: Number.isFinite(telemetry.progress) ? Math.max(0, Math.min(100, Math.trunc(telemetry.progress!))) : null,
    updateState: telemetry.state,
    updateTargetVersion: telemetry.targetVersion?.trim() || null,
    updateUpdatedAt: telemetry.updatedAt,
  };
}

function sanitizeUpdateRing(value: unknown): DeviceUpdateRing | undefined {
  return value === "canary" || value === "pilot" || value === "general" ? value : undefined;
}

export async function pollAgentCommandsWithFirebase(
  input: { deviceId: string; installId: string },
  env: AgentFirebaseEnv = process.env,
): Promise<AgentCommandPollResult> {
  const services = getAgentFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", input.deviceId);
  const deviceSnapshot = await getDoc(deviceRef);
  if (!deviceSnapshot.exists()) {
    throwStatusError("Firebase device not found", 404);
  }

  const data = deviceSnapshot.data() as { installId?: string };
  if (data.installId && data.installId !== input.installId) {
    throwStatusError("Firebase device installId mismatch", 409);
  }

  const commandQuery = query(
    collection(services.db, "devices", input.deviceId, "commands"),
    where("state", "==", "pending"),
    limit(50),
  );
  const snapshot = await getDocs(commandQuery);
  const batch = writeBatch(services.db);
  const commands: AgentCommand[] = [];

  snapshot.docs.forEach((commandDoc) => {
    const command = commandDoc.data() as { action?: unknown; createdAt?: unknown; sessionId?: unknown };
    const action = typeof command.action === "string" ? command.action : "";
    if (!action) {
      safeBatchUpdate(batch, commandDoc.ref, {
        state: "ignored",
        deliveredAt: serverTimestamp(),
      });
      return;
    }

    commands.push({
      id: commandDoc.id,
      action,
      createdAt: coerceCreatedAt(command.createdAt),
      deviceId: input.deviceId,
      ...(typeof command.sessionId === "string" ? { sessionId: command.sessionId } : {}),
    });
    safeBatchUpdate(batch, commandDoc.ref, {
      state: "delivered",
      deliveredAt: serverTimestamp(),
    });
  });

  if (snapshot.docs.length > 0) {
    await batch.commit();
  }

  return { commands };
}

export async function subscribeAgentCommandsWithFirebase(
  input: { deviceId: string; installId: string },
  onCommands: (commands: AgentCommand[]) => void | Promise<void>,
  onError: (error: Error) => void,
  env: AgentFirebaseEnv = process.env,
): Promise<Unsubscribe> {
  const services = getAgentFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", input.deviceId);
  try {
    const deviceSnapshot = await getDoc(deviceRef);
    if (!deviceSnapshot.exists()) {
      throwStatusError("Firebase device not found", 404);
    }
    const data = deviceSnapshot.data() as { installId?: string };
    if (data.installId && data.installId !== input.installId) {
      throwStatusError("Firebase device installId mismatch", 409);
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    onError(normalized);
    throw normalized;
  }

  const commandQuery = query(
    collection(services.db, "devices", input.deviceId, "commands"),
    where("state", "==", "pending"),
    limit(50),
  );
  let active = true;
  let serialized = Promise.resolve();
  const unsubscribe = onSnapshot(
    commandQuery,
    (snapshot) => {
      serialized = serialized.then(async () => {
        if (!active || snapshot.docs.length === 0) {
          return;
        }
        const batch = writeBatch(services.db);
        const commands: AgentCommand[] = [];
        snapshot.docs.forEach((commandDoc) => {
          const command = commandDoc.data() as { action?: unknown; createdAt?: unknown; sessionId?: unknown };
          const action = typeof command.action === "string" ? command.action : "";
          if (!action) {
            safeBatchUpdate(batch, commandDoc.ref, {
              state: "ignored",
              deliveredAt: serverTimestamp(),
            });
            return;
          }
          commands.push({
            id: commandDoc.id,
            action,
            createdAt: coerceCreatedAt(command.createdAt),
            deviceId: input.deviceId,
            ...(typeof command.sessionId === "string" ? { sessionId: command.sessionId } : {}),
          });
          safeBatchUpdate(batch, commandDoc.ref, {
            state: "delivered",
            deliveredAt: serverTimestamp(),
          });
        });
        await batch.commit();
        if (active && commands.length > 0) {
          await onCommands(commands);
        }
      }).catch((error) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      });
    },
    (error) => onError(error instanceof Error ? error : new Error(String(error))),
  );
  return () => {
    active = false;
    unsubscribe();
  };
}

export async function fetchActiveFirebaseSessionsForAgent(
  input: { deviceId: string; installId: string },
  env: AgentFirebaseEnv = process.env,
): Promise<ActiveFirebaseSession[]> {
  const services = getAgentFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", input.deviceId);
  const deviceSnapshot = await getDoc(deviceRef);
  if (!deviceSnapshot.exists()) {
    throwStatusError("Firebase device not found", 404);
  }

  const data = deviceSnapshot.data() as { installId?: string };
  if (data.installId && data.installId !== input.installId) {
    throwStatusError("Firebase device installId mismatch", 409);
  }
  const sessionsQuery = query(
    collection(services.db, "sessions"),
    where("deviceId", "==", input.deviceId),
    where("state", "==", "connected"),
  );
  const snapshot = await getDocs(sessionsQuery);
  return snapshot.docs
    .map((sessionDoc) => ({ id: sessionDoc.id, data: sessionDoc.data() as Record<string, unknown> }))
    .sort((left, right) => sessionStartedAtMs(right.data) - sessionStartedAtMs(left.data))
    .slice(0, 1)
    .map((session) => ({ id: session.id, deviceId: input.deviceId }));
}

export async function postSessionTilesWithFirebase(
  sessionId: string,
  input: { tiles: any[]; width: number; height: number; sequence?: number; keyframe?: boolean },
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const serialized = JSON.stringify(input);
  if (serialized.length > 850_000) {
    console.warn(`[Firebase Stream] Dropping oversized tile frame (${serialized.length} bytes).`);
    return;
  }
  const services = getAgentFirebaseServices(env);
  await safeAddDoc(collection(services.db, "sessions", sessionId, "tileFrames"), {
    tiles: input.tiles,
    width: input.width,
    height: input.height,
    keyframe: input.keyframe === true,
    ...(Number.isSafeInteger(input.sequence) ? { sequence: input.sequence } : {}),
    createdAt: serverTimestamp(),
  });
}

export async function startAgentWebRtcTransportWithFirebase(
  sessionId: string,
  handlers: AgentWebRtcTransportHandlers = {},
  env: AgentFirebaseEnv = process.env,
): Promise<AgentWebRtcTransport | null> {
  const services = getAgentFirebaseServices(env);
  const signalRef = doc(services.db, "sessions", sessionId, "webrtc", "signal");
  const connectTimeoutMs = resolveWebRtcConnectTimeoutMs(env);
  const signalSnapshot = await waitForWebRtcOffer(signalRef, connectTimeoutMs);
  if (!signalSnapshot) {
    handlers.onState?.(
      "error",
      formatWebRtcConnectionFailure("timeout", `${connectTimeoutMs}ms without a Viewer offer`),
    );
    return null;
  }
  requireTurnWhenRelayOnly(env);
  const agentCandidates = collection(services.db, "sessions", sessionId, "agentCandidates");
  const viewerCandidates = collection(services.db, "sessions", sessionId, "viewerCandidates");
  const recentNegotiationIds = new Set<string>();
  const appliedViewerCandidates = new Set<string>();
  const maxMessageBytes = resolveWebRtcMaxMessageBytes(env);
  let activeNegotiationId: string | null = null;
  let activePeer: AgentPeerConnectionLike | null = null;
  let activeRemoteDescriptionSet = false;
  let tileChannel: AgentDataChannelLike | null = null;
  let controlChannel: AgentDataChannelLike | null = null;
  let fileChannel: AgentDataChannelLike | null = null;
  let fileChannelTasks: AgentDataChannelTaskQueue | null = null;
  let channelOpened = false;
  let closedByCaller = false;
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeSignal: Unsubscribe | null = null;
  let unsubscribeViewerCandidates: Unsubscribe | null = null;
  let negotiationQueue = Promise.resolve();

  const clearConnectWatchdog = () => {
    if (connectWatchdog) {
      clearTimeout(connectWatchdog);
      connectWatchdog = null;
    }
  };

  const reportTransportError = (reason: string, detail?: string) => {
    if (closedByCaller) {
      return;
    }
    handlers.onState?.("error", formatWebRtcConnectionFailure(reason, detail));
  };

  const closeActivePeer = async (expectedNegotiationId?: string) => {
    if (expectedNegotiationId && activeNegotiationId !== expectedNegotiationId) {
      return;
    }
    clearConnectWatchdog();
    const previousTileChannel = tileChannel;
    const previousControlChannel = controlChannel;
    const previousFileChannel = fileChannel;
    const previousFileChannelTasks = fileChannelTasks;
    const peer = activePeer;
    tileChannel = null;
    controlChannel = null;
    fileChannel = null;
    fileChannelTasks = null;
    activePeer = null;
    activeRemoteDescriptionSet = false;
    previousFileChannelTasks?.close();
    previousTileChannel?.close?.();
    previousControlChannel?.close?.();
    previousFileChannel?.close?.();
    if (peer) {
      try {
        await peer.close();
      } catch {
        // best effort cleanup before a new negotiation
      }
    }
  };

  const failNegotiation = (negotiationId: string, reason: string, detail?: string) => {
    if (closedByCaller || activeNegotiationId !== negotiationId) {
      return;
    }
    clearConnectWatchdog();
    reportTransportError(reason, detail);
    void closeActivePeer(negotiationId);
  };

  const applyViewerCandidateDocs = (
    docs: readonly { id: string; data: () => Record<string, any> }[],
  ) => {
    const negotiationId = activeNegotiationId;
    const peer = activePeer;
    if (!negotiationId || !peer || !activeRemoteDescriptionSet) {
      return;
    }
    docs.forEach((candidateDoc) => {
      const candidateData = candidateDoc.data();
      const candidateKey = `${negotiationId}:${candidateDoc.id}`;
      if (
        appliedViewerCandidates.has(candidateKey) ||
        !candidateMatchesNegotiation(candidateData, negotiationId)
      ) {
        return;
      }
      appliedViewerCandidates.add(candidateKey);
      void peer.addIceCandidate(candidateData.candidate).catch((error: unknown) => {
        appliedViewerCandidates.delete(candidateKey);
        console.warn(`[WebRTC] Failed to add Viewer ICE candidate: ${error instanceof Error ? error.message : error}`);
      });
    });
  };

  const activateNegotiation = async (signal: unknown) => {
    const offer = parseAgentWebRtcOffer(signal);
    if (!offer || closedByCaller) {
      return;
    }
    if (!rememberNegotiationAttempt(recentNegotiationIds, offer.negotiationId)) {
      return;
    }

    await closeActivePeer();
    if (closedByCaller) {
      return;
    }

    activeNegotiationId = offer.negotiationId;
    activeRemoteDescriptionSet = false;
    channelOpened = false;
    const peer = await createAgentPeerConnection({
      iceServers: resolveRtcIceServers(env),
      iceTransportPolicy: shouldUseRelayOnly(env) ? "relay" : "all",
    });
    if (closedByCaller || activeNegotiationId !== offer.negotiationId) {
      await peer.close();
      return;
    }
    activePeer = peer;

    peer.onicecandidate = (event) => {
      if (!event.candidate || activeNegotiationId !== offer.negotiationId) {
        return;
      }
      const candidate = event.candidate.toJSON?.() ?? event.candidate;
      void safeAddDoc(agentCandidates, {
        candidate,
        createdAt: serverTimestamp(),
        negotiationId: offer.negotiationId,
      }).catch((error) => {
        reportTransportError(
          "agent-candidate-write-failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    };

    peer.ondatachannel = (event) => {
      if (activeNegotiationId !== offer.negotiationId) {
        event.channel.close?.();
        return;
      }
      routeAgentDataChannel(event.channel, {
        onTiles: (channel) => {
          if (tileChannel && tileChannel !== channel) {
            console.warn("[WebRTC] Ignoring duplicate Agent tile data channel.");
            channel.close?.();
            return;
          }
          tileChannel = channel;
          bindAgentDataChannelStatus(channel, {
            onState: (state, error) => {
              if (activeNegotiationId !== offer.negotiationId) {
                return;
              }
              if (state === "open") {
                channelOpened = true;
                clearConnectWatchdog();
                handlers.onState?.("open");
                return;
              }
              if (state === "closed") {
                handlers.onState?.("closed");
                void closeActivePeer(offer.negotiationId);
                return;
              }
              failNegotiation(offer.negotiationId, "data-channel-error", error);
            },
          });
        },
        onControl: (channel) => {
          if (controlChannel && controlChannel !== channel) {
            console.warn("[WebRTC] Ignoring duplicate Agent control data channel.");
            channel.close?.();
            return;
          }
          controlChannel = channel;
          const isCurrentChannel = () => !(
            closedByCaller ||
            activeNegotiationId !== offer.negotiationId ||
            controlChannel !== channel
          );
          let controlChannelEnded = false;
          const clearControlChannel = () => {
            if (controlChannelEnded) {
              return;
            }
            controlChannelEnded = true;
            channel.onmessage = undefined;
            if (controlChannel === channel) {
              controlChannel = null;
            }
            handlers.onControlClosed?.();
          };
          bindAgentControlMessages(channel, {
            onControl: (action) => handlers.onControl?.(action, isCurrentChannel),
            onInvalidMessage: () => {
              console.warn("[WebRTC] Ignoring malformed, oversized, or binary Agent control message.");
            },
          });
          channel.onopen = () => console.log("[WebRTC] Agent control data channel state: open");
          channel.onclose = () => {
            clearControlChannel();
            console.log("[WebRTC] Agent control data channel state: closed");
          };
          channel.onerror = () => {
            clearControlChannel();
            channel.close?.();
            console.warn("[WebRTC] Agent control data channel error.");
          };
        },
        onFiles: (channel) => {
          if (fileChannel && fileChannel !== channel) {
            console.warn("[WebRTC] Ignoring duplicate Agent file data channel.");
            channel.close?.();
            return;
          }
          fileChannel = channel;
          const tasks = bindAgentFileMessages(channel, {
            onChunk: async (chunk) => {
              const isCurrentChannel = () => !(
                closedByCaller ||
                activeNegotiationId !== offer.negotiationId ||
                fileChannel !== channel
              );
              if (!isCurrentChannel()) {
                return;
              }
              let acknowledgement: WebRtcFileAckMessage | null;
              try {
                if (!handlers.onFileChunk) {
                  throw new Error("Agent file receiver is unavailable.");
                }
                acknowledgement = await handlers.onFileChunk(chunk, isCurrentChannel);
              } catch (error) {
                console.warn(
                  `[WebRTC] Agent file chunk processing failed: ${error instanceof Error ? error.message : error}`,
                );
                acknowledgement = {
                  type: "file-ack",
                  transferId: chunk.transferId,
                  receivedBytes: 0,
                  receivedChunks: 0,
                  status: "error",
                  error: Array.from(error instanceof Error ? error.message : String(error))
                    .slice(0, 200)
                    .join("") || "Agent file chunk processing failed.",
                };
              }
              if (
                !acknowledgement ||
                !isCurrentChannel() ||
                channel.readyState !== "open" ||
                !channel.send
              ) {
                return;
              }
              try {
                channel.send(serializeWebRtcFileAck(acknowledgement));
              } catch (error) {
                console.warn(
                  `[WebRTC] Failed to acknowledge Agent file chunk: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
            onError: (error) => {
              console.warn(
                `[WebRTC] Agent file message queue failed: ${error instanceof Error ? error.message : error}`,
              );
            },
            onInvalidMessage: () => {
              console.warn("[WebRTC] Ignoring malformed, oversized, or binary Agent file message.");
            },
          });
          fileChannelTasks = tasks;
          const clearFileChannel = () => {
            tasks.close();
            if (fileChannelTasks === tasks) {
              fileChannelTasks = null;
            }
            if (fileChannel === channel) {
              fileChannel = null;
            }
          };
          channel.onopen = () => console.log("[WebRTC] Agent file data channel state: open");
          channel.onclose = () => {
            clearFileChannel();
            console.log("[WebRTC] Agent file data channel state: closed");
          };
          channel.onerror = () => {
            clearFileChannel();
            channel.close?.();
            console.warn("[WebRTC] Agent file data channel error.");
          };
        },
        onUnknown: (channel) => {
          console.warn(`[WebRTC] Ignoring unexpected Agent data channel: ${channel.label ?? "<unlabeled>"}`);
          channel.close?.();
        },
      });
    };

    peer.onconnectionstatechange = () => {
      if (activeNegotiationId !== offer.negotiationId) {
        return;
      }
      const state = String(peer.connectionState ?? "");
      if (isTerminalWebRtcConnectionState(state)) {
        failNegotiation(offer.negotiationId, state);
      }
    };

    await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    activeRemoteDescriptionSet = true;
    void getDocs(viewerCandidates)
      .then((snapshot) => applyViewerCandidateDocs(snapshot.docs))
      .catch((error) => {
        reportTransportError(
          "viewer-candidate-refresh-failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await safeSetDoc(
      signalRef,
      {
        answer: {
          negotiationId: offer.negotiationId,
          type: answer.type,
          sdp: answer.sdp,
        },
        negotiationId: offer.negotiationId,
        state: "agent-answer",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    if (!channelOpened) {
      connectWatchdog = setTimeout(() => {
        failNegotiation(
          offer.negotiationId,
          "timeout",
          `${connectTimeoutMs}ms without an open Agent data channel`,
        );
      }, connectTimeoutMs);
    }
  };

  const scheduleNegotiation = (signal: unknown) => {
    const offer = parseAgentWebRtcOffer(signal);
    if (!offer || recentNegotiationIds.has(offer.negotiationId)) {
      return;
    }
    negotiationQueue = negotiationQueue
      .then(() => activateNegotiation(signal))
      .catch((error) => {
        reportTransportError("negotiation-failed", error instanceof Error ? error.message : String(error));
        if (activeNegotiationId) {
          void closeActivePeer(activeNegotiationId);
        }
      });
  };

  try {
    await activateNegotiation(signalSnapshot);
  } catch (error) {
    reportTransportError("negotiation-failed", error instanceof Error ? error.message : String(error));
    if (activeNegotiationId) {
      await closeActivePeer(activeNegotiationId);
    }
  }

  unsubscribeSignal = onSnapshot(
    signalRef,
    (snapshot) => scheduleNegotiation(snapshot.data()),
    (error) => reportTransportError("signal-listener-failed", error.message),
  );
  unsubscribeViewerCandidates = onSnapshot(
    viewerCandidates,
    (snapshot) => applyViewerCandidateDocs(snapshot.docs),
    (error) => reportTransportError("viewer-candidate-listener-failed", error.message),
  );

  return {
    close: async () => {
      closedByCaller = true;
      clearConnectWatchdog();
      unsubscribeSignal?.();
      unsubscribeViewerCandidates?.();
      await negotiationQueue.catch(() => undefined);
      await closeActivePeer();
    },
    getBufferedAmount: () => dataChannelBufferedAmount(tileChannel),
    sendFrame: (frame, maxBufferedAmountOverride) => sendFrameWithBackpressure(
      tileChannel,
      frame,
      {
        maxBufferedAmount: resolveAgentFrameMaxBufferedAmount(maxBufferedAmountOverride, env),
        maxMessageBytes,
      },
    ),
  };
}

export async function fetchSessionDataWithFirebase(
  sessionId: string,
  env: AgentFirebaseEnv = process.env,
): Promise<{
  messages: ChatMessage[];
  clipboards: ClipboardData[];
  files: TransferredFile[];
}> {
  const messages = await drainFirebaseSessionQueue(sessionId, "chat", 100, "agent", (id, data) => ({
    id,
    message: String(data.message ?? ""),
    sender: (data.sender === "agent" ? "agent" : "viewer") as "agent" | "viewer",
    createdAt: coerceCreatedAt(data.createdAt),
  }), env);
  const clipboards = await drainFirebaseSessionQueue(sessionId, "clipboard", 100, "agent", (_id, data) => ({
    text: String(data.text ?? ""),
    sender: (data.sender === "agent" ? "agent" : "viewer") as "agent" | "viewer",
  }), env);
  const files = await drainFirebaseSessionQueue(sessionId, "files", 200, "agent", (id, data) => ({
    id,
    filename: String(data.filename ?? ""),
    fileData: String(data.fileData ?? ""),
    transferId: typeof data.transferId === "string" ? data.transferId : undefined,
    chunkIndex: typeof data.chunkIndex === "number" ? data.chunkIndex : undefined,
    totalChunks: typeof data.totalChunks === "number" ? data.totalChunks : undefined,
    totalBytes: typeof data.totalBytes === "number" ? data.totalBytes : undefined,
    isLast: typeof data.isLast === "boolean" ? data.isLast : undefined,
    chunkSha256: typeof data.chunkSha256 === "string" ? data.chunkSha256 : undefined,
    fileSha256: typeof data.fileSha256 === "string" ? data.fileSha256 : undefined,
    delivery: data.delivery === "firebase-storage" ? ("firebase-storage" as const) : ("firestore-direct" as const),
    storagePath: typeof data.storagePath === "string" ? data.storagePath : undefined,
    webkitRelativePath: typeof data.webkitRelativePath === "string" ? data.webkitRelativePath : undefined,
  }), env);

  return {
    messages,
    clipboards,
    files,
  };
}

export async function resolveFirebaseStorageDownloadUrl(
  storagePath: string,
  env: AgentFirebaseEnv = process.env,
): Promise<string> {
  const services = getAgentFirebaseServices(env);
  return getDownloadURL(ref(services.storage, storagePath));
}

export async function postClipboardWithFirebase(
  sessionId: string,
  input: ClipboardData,
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const services = getAgentFirebaseServices(env);
  await safeAddDoc(collection(services.db, "sessions", sessionId, "clipboard"), {
    ...input,
    target: oppositeSessionSender(input.sender),
    createdAt: serverTimestamp(),
  });
}

export async function postChatWithFirebase(
  sessionId: string,
  input: Omit<ChatMessage, "id" | "createdAt">,
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const services = getAgentFirebaseServices(env);
  await safeAddDoc(collection(services.db, "sessions", sessionId, "chat"), {
    ...input,
    target: oppositeSessionSender(input.sender),
    createdAt: serverTimestamp(),
  });
}

export async function postFileTransferReceiptWithFirebase(
  sessionId: string,
  input: Omit<FileTransferReceipt, "updatedAt">,
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const services = getAgentFirebaseServices(env);
  await safeSetDoc(
    doc(services.db, "sessions", sessionId, "fileReceipts", input.transferId),
    {
      ...input,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

async function drainFirebaseSessionQueue<T>(
  sessionId: string,
  queueName: string,
  queueLimit: number,
  target: "viewer" | "agent" | undefined,
  mapItem: (id: string, data: Record<string, unknown>) => T,
  env: AgentFirebaseEnv,
): Promise<T[]> {
  const services = getAgentFirebaseServices(env);
  const queueCollection = collection(services.db, "sessions", sessionId, queueName);
  const queueQuery = target
    ? query(queueCollection, where("target", "==", target), limit(queueLimit))
    : query(queueCollection, orderBy("createdAt", "asc"), limit(queueLimit));
  const snapshot = await getDocs(queueQuery);
  if (snapshot.empty) {
    return [];
  }

  const batch = writeBatch(services.db);
  const items = snapshot.docs.map((item) => {
    batch.delete(item.ref);
    return mapItem(item.id, item.data());
  });
  await batch.commit();
  return items;
}

async function waitForWebRtcOffer(
  signalRef: ReturnType<typeof doc>,
  timeoutMs = 8_000,
): Promise<Record<string, any> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await getDoc(signalRef);
    const data = snapshot.data() as Record<string, any> | undefined;
    if (parseAgentWebRtcOffer(data)) {
      return data ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function oppositeSessionSender(sender: "viewer" | "agent"): "viewer" | "agent" {
  return sender === "viewer" ? "agent" : "viewer";
}

function getAgentFirebaseServices(env: AgentFirebaseEnv) {
  const config = resolveFirebaseConfig(env);
  if (!config) {
    throw new Error("Firebase config is missing. Set WONREMOTE_FIREBASE_* values.");
  }
  return getWonRemoteFirebaseServices(config);
}

function coerceCreatedAt(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return new Date().toISOString();
}

function sessionStartedAtMs(data: Record<string, unknown>): number {
  const startedAt = data.startedAt;
  if (typeof startedAt === "string") {
    const parsed = Date.parse(startedAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const createdAt = data.createdAt;
  if (createdAt && typeof createdAt === "object") {
    if ("toMillis" in createdAt && typeof createdAt.toMillis === "function") {
      return Number(createdAt.toMillis()) || 0;
    }
    if ("toDate" in createdAt && typeof createdAt.toDate === "function") {
      return createdAt.toDate().getTime();
    }
  }
  return 0;
}

function throwStatusError(message: string, status: number): never {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  throw error;
}

function isFirebaseAuthCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isFirebaseNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "not-found"
  );
}
