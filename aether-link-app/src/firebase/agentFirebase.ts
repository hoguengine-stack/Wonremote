import { isIP } from "node:net";
import { beginConnectionTiming, markConnectionTiming } from "../domain/connectionTiming";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { subscribeFirebaseSessionData } from "./sessionData";
import { DEVICE_ACCESS_TTL_MS, type DeviceAccessRequest, type DeviceAccessState } from "../domain/deviceAccessLock";
import type { AgentDeviceAccessLock } from "../agent/deviceAccessLock";
import { resolveFirestoreTileFallbackPolicy } from "../agent/agentStreamPolicy";
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { orderAgentCommands } from "../domain/agentCommandOrdering";
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
import { resolveRtcConfiguration } from "../domain/rtcTransport";
import {
  formatWebRtcConnectionFailure,
  isTerminalWebRtcConnectionState,
  MAX_RECENT_WEBRTC_CANDIDATES,
  resolveWebRtcConnectTimeoutMs,
  webRtcReconnectDelayMs,
} from "../domain/webrtcStability";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { selectRecoverableAgentSession } from "./agentSessionRecovery";
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
  publishAnswerDuringGathering,
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
  WEBRTC_REVERSE_FILE_CAPABILITY,
  serializeWebRtcFileStatus,
  type WebRtcFileStatusMessage,
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
import { parseRolloutSelection } from "../domain/updateFleetPolicy";
import type { DeviceUpdateRing } from "../domain/types";

type AgentFirebaseEnv = Record<string, string | undefined>;
import { createFileChannelSender, type AgentFileSendInput } from "../agent/fileChannelSender";

export interface AgentWebRtcTransport {
  isClosed: () => boolean;
  sendFileStatus: (status: WebRtcFileStatusMessage) => boolean;
  sendFile: (input: AgentFileSendInput) => Promise<void>;
  close: () => Promise<void>;
  getBufferedAmount: () => number;
  sendFrame: (
      frame: { tiles: any[]; width: number; height: number; sequence: number; keyframe: boolean; cursorEmbedded?: boolean },
    maxBufferedAmountOverride?: number,
  ) => "backpressure" | "sent" | "unavailable";
}

type ControlChannelOwner = (requireOpen?: boolean) => boolean;

export interface AgentWebRtcTransportHandlers {
  onControl?: (action: string, isCurrentChannel: ControlChannelOwner) => void;
  onControlClosed?: (channel: ControlChannelOwner) => void;
  onFileChunk?: (
    chunk: WebRtcFileChunkMessage,
    isCurrentChannel: () => boolean,
  ) => Promise<WebRtcFileAckMessage | null> | WebRtcFileAckMessage | null;
  onState?: (state: "negotiating" | "open" | "closed" | "error", error?: string) => void;
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
      if (hasFirebaseErrorCode(createError, "auth/email-already-in-use")) {
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
    storeName: input.storeName, deviceName: input.deviceName, notes: input.notes,
    businessNumber: input.businessNumber,
    desktopName: input.desktopName,
    installId: input.installId,
    nowIso,
    ownerUid: credential.user.uid,
    protocolVersion: input.protocolVersion,
    platform: input.platform,
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
      Boolean(input.desktopName?.trim()),
    );

    if (previousSnapshot?.exists()) {
      const previous = previousSnapshot.data() as Record<string, unknown>;
      if (canRetirePreviousDevice(previous, device, credential.user.uid, input.installId)) {
        if (!existingSnapshot.exists()) {
          const firstRegisteredAt = mapFirestoreDevice(previousDeviceId!, previous).firstRegisteredAt;
          if (firstRegisteredAt) deviceDocument.firstRegisteredAt = firstRegisteredAt;
          else delete deviceDocument.firstRegisteredAt;
        }
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
        lastSeenAtServer: serverTimestamp(),
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

export async function fetchAgentBusinessNumberWithFirebase(deviceId: string): Promise<string> {
  const snapshot = await getDocFromServer(doc(getAgentFirebaseServices(process.env).db, "devices", deviceId));
  if (!snapshot.exists()) throw new Error("Agent device not found.");
  return String(snapshot.data().businessNumber ?? "");
}

export async function fetchAgentZookNumberWithFirebase(deviceId: string): Promise<string> {
  const snapshot = await getDocFromServer(doc(getAgentFirebaseServices(process.env).db, "devices", deviceId));
  if (!snapshot.exists()) throw new Error("Agent device not found.");
  return String(snapshot.data().zookNumber ?? "");
}

export async function sendAgentHeartbeatWithFirebase(
  input: AgentHeartbeatInput,
  env: AgentFirebaseEnv = process.env,
): Promise<AgentHeartbeatResult> {
  const services = getAgentFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", input.deviceId);
  const nowIso = new Date().toISOString();
  const desktopName = input.desktopName?.trim().slice(0, 255);
  try {
    // Firestore rules keep installId immutable; a mismatched Agent update is rejected there.
    await safeUpdateDoc(deviceRef, {
      ...(input.accessPublicKey !== undefined ? {accessPublicKey:input.accessPublicKey, accessLockUnavailable:input.accessLockUnavailable === true} : {}),
      selectedRolloutVersion: input.version && /^\d+\.\d+\.\d+$/.test(input.version) ? input.version : null,
      rollbackSupportVersion: input.version && /^\d+\.\d+\.\d+$/.test(input.version) ? input.version : null,
      presenceMode: input.presenceMode,
      heartbeatRequestId: input.heartbeatRequestId,
      activeDisplayIndex: input.activeDisplayIndex,
      ...(input.displays !== undefined ? {displays:input.displays} : {}),
      installId: input.installId,
      lastSeenAt: nowIso,
      lastSeenAtServer: serverTimestamp(),
      macAddresses: input.macAddresses ?? [],
      systemInfo: input.systemInfo ?? null,
      ...(input.controlDiagnostics !== undefined ? {controlDiagnostics:input.controlDiagnostics} : {}),
      deletedAt: null,
      streamDiagnostics: input.streamDiagnostics ?? null,
      status: "online",
      updatedAt: serverTimestamp(),
      protocolVersion: input.protocolVersion,
      platform: input.platform,
      version: input.version,
      ...(desktopName ? { desktopName } : {}),
      ...(input.updateTelemetry ? updateTelemetryDocument(input.updateTelemetry) : {}),
      ...(input.zookResult ? { zookAppliedNumber: input.zookResult.appliedNumber ?? "", ...(input.zookResult.error !== undefined ? {zookError: input.zookResult.error.slice(0,500)} : {}) } : {}),
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
    desktopName: desktopName ?? "",
    storeName: "",
    lastSeenAt: nowIso,
    protocolVersion: input.protocolVersion,
    platform: input.platform,
    status: "online",
    version: input.version,
    activeDisplayIndex: input.activeDisplayIndex,
    displays: input.displays ?? [],
    macAddresses: input.macAddresses ?? [],
    systemInfo: input.systemInfo,
    controlDiagnostics: input.controlDiagnostics,
    streamDiagnostics: input.streamDiagnostics,
  });

  return {
    devices: [device],
    device,
  };
}

export async function readAgentDeviceAccessState(deviceId: string, env: AgentFirebaseEnv = process.env): Promise<{enabled: boolean; version: string}> {
  const snapshot = await getDocFromServer(doc(getAgentFirebaseServices(env).db, "deviceAccessLocks", deviceId));
  const value = snapshot.data();
  return {enabled:value?.enabled === true, version:typeof value?.version === "string" ? value.version : ""};
}

export async function publishAgentDeviceAccessCapability(deviceId: string, publicKey: string | null, env: AgentFirebaseEnv = process.env): Promise<void> {
  await safeUpdateDoc(doc(getAgentFirebaseServices(env).db, "devices", deviceId), {accessPublicKey:publicKey, accessLockUnavailable:publicKey === null});
}

export async function processAgentDeviceAccessRequest(
  deviceId: string, requestId: string, lock: AgentDeviceAccessLock, stopActiveSession: () => Promise<void>, env: AgentFirebaseEnv = process.env,
): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("잘못된 잠금 요청 번호입니다.");
  const {db} = getAgentFirebaseServices(env);
  const requestRef = doc(db, "deviceAccessRequests", requestId);
  const snapshot = await getDocFromServer(requestRef);
  const data = snapshot.data();
  if (!data || data.state !== "pending") return;
  const request = data as DeviceAccessRequest & {createdAt: {toMillis(): number}};
  try {
    const createdAt = request.createdAt?.toMillis?.();
    if (!Number.isFinite(createdAt) || createdAt > Date.now() + 5_000 || createdAt < Date.now() - DEVICE_ACCESS_TTL_MS) throw new Error("접속 잠금 요청 시간이 만료되었습니다.");
    if (request.deviceId !== deviceId || request.id !== requestId) throw new Error("다른 장비의 잠금 요청입니다.");
    const verifyCurrentLock = async () => {
      const previous = await readAgentDeviceAccessState(deviceId, env);
      if (request.lockVersion !== previous.version) throw new Error("잠금 설정이 변경되었습니다. 장비 목록을 새로고침하세요.");
      if (previous.enabled && !lock.publicState.enabled && request.operation !== "reset") throw new Error("잠금 설정 복구가 필요합니다. 관리자 비밀번호로 재설정하세요.");
    };
    const local = lock.publicState;
    const overlap = request.operation === "connect" && local.enabled && local.version === request.lockVersion;
    if (!overlap) await verifyCurrentLock();
    await lock.authorize(request, Date.now(), async (state: DeviceAccessState) => {
      if (request.operation !== "connect") await stopActiveSession();
      await runTransaction(db, async transaction => {
        const lockRef = doc(db, "deviceAccessLocks", deviceId);
        const [currentRequest, currentLock] = await Promise.all([
          transaction.get(requestRef), transaction.get(lockRef),
        ]);
        if (currentRequest.data()?.state !== "pending" || (currentLock.data()?.version ?? "") !== request.lockVersion) throw new Error("잠금 요청이 이미 처리되었거나 설정이 변경되었습니다.");
        if (request.operation !== "connect") {
          transaction.set(lockRef, {enabled:state.enabled, version:state.version, updatedAt:serverTimestamp()});
          transaction.update(doc(db, "devices", deviceId), {accessLocked:state.enabled, accessLockVersion:state.version});
        }
        transaction.update(requestRef, {state:"approved", approvedVersion:state.version, approvalSignature:lock.signApproval(request, state.version), updatedAt:serverTimestamp()});
      });
    }, overlap ? verifyCurrentLock : undefined);
  } catch (error) {
    await safeUpdateDoc(requestRef, {state:"denied", error:error instanceof Error ? error.message : "접속 잠금 요청을 처리하지 못했습니다.", updatedAt:serverTimestamp()});
  }
}

export async function isAgentDeviceAccessSessionAllowed(deviceId: string, sessionId: string, lock: AgentDeviceAccessLock | null, env: AgentFirebaseEnv = process.env): Promise<boolean> {
  const {db} = getAgentFirebaseServices(env);
  let observedLock: Awaited<ReturnType<typeof readAgentDeviceAccessState>> | null | undefined;
  const lockRead = readAgentDeviceAccessState(deviceId, env).then(state => observedLock = state, error => {
    observedLock = null;
    throw error;
  });
  const admissionRead = lock?.publicState.enabled ? getDocFromServer(doc(db, "sessions", sessionId)).then(snapshot => {
    const session = snapshot.data();
    if (session?.deviceId !== deviceId || session.state !== "connected" || !lock.publicState.enabled
      || session.accessLockVersion !== lock.publicState.version || typeof session.accessRequestId !== "string"
      || observedLock === null || (observedLock && (!observedLock.enabled || observedLock.version !== session.accessLockVersion))) return null;
    // Approval is immutable after it is granted. Prefetch it, but never authorize before the fresh lock read.
    const readRequest = async () => (await getDocFromServer(doc(db, "deviceAccessRequests", session.accessRequestId))).data();
    const requestRead = readRequest().then(request => ({request}), error => ({error}));
    return {session, requestRead};
  }) : undefined;
  const [current, admission] = await Promise.all([lockRead, admissionRead]);
  if (!current.enabled) return lock?.publicState.enabled !== true;
  if (!lock?.publicState.enabled || lock.publicState.version !== current.version || admission?.session.accessLockVersion !== current.version) return false;
  const result = await admission.requestRead;
  if ("error" in result) throw result.error;
  const {request} = result;
  return request?.state === "approved" && request.operation === "connect" && request.sessionId === sessionId
    && request.deviceId === deviceId && request.ownerUid === admission.session.ownerUid && request.approvedVersion === current.version
    && lock.verifyApproval(request as DeviceAccessRequest, current.version, request.approvalSignature);
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
  requireServer = false,
): Promise<{ rollout: UpdateFleetRollout; updatePaused: boolean; updateRing: DeviceUpdateRing } | null> {
  const services = getAgentFirebaseServices(env);
  const read = requireServer ? readAgentUpdateServerDocument : getDoc;
  const [deviceSnapshot, rolloutSnapshot] = await Promise.all([
    read(doc(services.db, "devices", deviceId)),
    read(doc(services.db, "configuration", "updateRollout")),
  ]);
  const rollout = parseAgentUpdateRollout(rolloutSnapshot.data());
  if (!deviceSnapshot.exists() || !rollout) return null;
  const device = deviceSnapshot.data() as Record<string, unknown>;
  return { rollout, updatePaused: device.updatePaused === true, updateRing: sanitizeUpdateRing(device.updateRing) ?? "general" };
}

export async function loadAgentUpdateRolloutPolicyWithFirebase(env: AgentFirebaseEnv = process.env): Promise<UpdateFleetRollout | null> {
  const { db } = getAgentFirebaseServices(env);
  return parseAgentUpdateRollout((await readAgentUpdateServerDocument(doc(db, "configuration", "updateRollout"))).data());
}

function readAgentUpdateServerDocument(ref: DocumentReference<DocumentData>): Promise<DocumentSnapshot<DocumentData>> {
  return new Promise((resolve, reject) => {
    let stop: Unsubscribe | undefined;
    const finish = () => { clearTimeout(deadline); stop?.(); };
    const deadline = setTimeout(() => {
      finish();
      reject(new Error("Agent update policy read timed out."));
    }, 5_000);
    try {
      stop = onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.fromCache) return;
        finish();
        resolve(snapshot);
      }, error => { finish(); reject(error); });
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

function parseAgentUpdateRollout(rollout: Record<string, unknown> | undefined): UpdateFleetRollout | null {
  if (!rollout) return null;
  const targetVersion = typeof rollout.targetVersion === "string" ? rollout.targetVersion.trim() : "";
  const stage = sanitizeUpdateRing(rollout.stage);
  if (!targetVersion || !stage) return null;
  return {
    targetVersion,
    stage,
    ...parseRolloutSelection(rollout.targetDeviceIds),
    paused: rollout.paused === true,
    percentage: typeof rollout.percentage === "number" ? rollout.percentage : 100,
  };
}

function updateTelemetryDocument(telemetry: AgentUpdateTelemetry): Record<string, unknown> {
  return {
    updateCurrentVersion: telemetry.currentVersion,
    updateRequestId: telemetry.requestId ?? null,
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
  const health = snapshot.docs.find(document => document.id === AGENT_HEALTH_COMMAND_ID);
  const verifiedHealth = health ? await acknowledgeAgentHealthCommand(services.db, health, input.deviceId) : null;
  const commands = await acknowledgeAgentCommands(services.db, commandQuery,
    snapshot.docs.filter(document => document.id !== AGENT_HEALTH_COMMAND_ID), input.deviceId);
  if (verifiedHealth) commands.push(verifiedHealth);
  return { commands: orderAgentCommands(commands) };
}

const AGENT_HEALTH_COMMAND_ID = "agent-health";
const AGENT_HEALTH_ACTION_PREFIX = "agent-health-check ";
const AGENT_HEALTH_CHALLENGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type AgentCommandDocument = { id: string; ref: DocumentReference<unknown>; data: () => unknown };

export async function queueAgentHealthChallengeWithFirebase(
  input: { deviceId: string; challengeId: string },
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  if (!AGENT_HEALTH_CHALLENGE_ID.test(input.challengeId)) {
    throw new Error("Invalid Agent health challenge.");
  }
  const services = getAgentFirebaseServices(env);
  await safeSetDoc(doc(services.db, "devices", input.deviceId, "commands", AGENT_HEALTH_COMMAND_ID), {
    action: AGENT_HEALTH_ACTION_PREFIX + input.challengeId,
    createdAt: serverTimestamp(),
    state: "pending",
  });
}

async function acknowledgeAgentHealthCommand(
  db: Parameters<typeof runTransaction>[0],
  document: AgentCommandDocument,
  deviceId: string,
  isActive: () => boolean = () => true,
): Promise<AgentCommand | null> {
  const {action} = document.data() as {action?: unknown};
  const valid = typeof action === "string" && action.startsWith(AGENT_HEALTH_ACTION_PREFIX) &&
    AGENT_HEALTH_CHALLENGE_ID.test(action.slice(AGENT_HEALTH_ACTION_PREFIX.length));
  try {
    return await runTransaction(db, async transaction => {
      if (!isActive()) return null;
      const current = (await transaction.get(document.ref)).data() as {action?: unknown; state?: unknown; createdAt?: unknown} | undefined;
      if (!isActive() || current?.state !== "pending" || current.action !== action) return null;
      safeBatchUpdate(transaction, document.ref, {state:valid ? "delivered" : "ignored", deliveredAt:serverTimestamp()});
      return valid ? {id:document.id,action,deviceId,createdAt:coerceCreatedAt(current.createdAt)} : null;
    }, {maxAttempts:2});
  } catch (error) {
    // A displaced challenge does not end the ordinary command listener.
    if (["aborted", "failed-precondition", "not-found"].some(code => hasFirebaseErrorCode(error, code))) return null;
    throw error;
  }
}

async function acknowledgeAgentCommands(
  db: Parameters<typeof writeBatch>[0],
  commandQuery: Parameters<typeof getDocsFromServer>[0],
  documents: readonly AgentCommandDocument[],
  deviceId: string,
  isActive: () => boolean = () => true,
  allowRecovery = true,
): Promise<AgentCommand[]> {
  if (!isActive() || documents.length === 0) return [];
  const entries = documents.map((document) => {
    const data = document.data() as { action?: unknown; createdAt?: unknown; sessionId?: unknown };
    const action = typeof data.action === "string" ? data.action : "";
    const command: AgentCommand | undefined = action ? {
      id: document.id,
      action,
      createdAt: coerceCreatedAt(data.createdAt),
      deviceId,
      ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
    } : undefined;
    if (action.startsWith("start-stream ") && command?.sessionId) beginConnectionTiming(command.sessionId, "agent");
    return {
      ref: document.ref,
      data,
      update: { state: command ? "delivered" : "ignored", deliveredAt: serverTimestamp() },
      command,
    };
  });
  const acknowledged = (committed: typeof entries) => {
    for (const entry of committed) {
      if (entry.command?.action.startsWith("start-stream ") && entry.command.sessionId) markConnectionTiming(entry.command.sessionId, "command-acknowledged");
    }
    return committed.flatMap(entry => entry.command ? [entry.command] : []);
  };
  const batch = writeBatch(db);
  for (const entry of entries) safeBatchUpdate(batch, entry.ref, entry.update);
  try {
    await batch.commit();
    return acknowledged(entries);
  } catch (error) {
    if (!allowRecovery) throw error;
    if (hasFirebaseErrorCode(error, "permission-denied")) {
      if (!isActive()) return [];
      // A deleted document can fail rule evaluation before the write reports NOT_FOUND.
      const committed = await runTransaction(db, async transaction => {
        if (!isActive()) return [];
        const current = await Promise.all(entries.map(entry => transaction.get(entry.ref)));
        if (!isActive()) return [];
        if (current.every(snapshot => snapshot.exists())) throw error;
        const survivors = entries.filter(({data}, index) => {
          const fresh = current[index].data() as (typeof data & {state?: unknown}) | undefined;
          if (fresh?.state !== "pending" || fresh.action !== data.action || fresh.sessionId !== data.sessionId) return false;
          const originalTime = data.createdAt;
          return typeof originalTime === "string" ? fresh.createdAt === originalTime :
            originalTime instanceof Timestamp && fresh.createdAt instanceof Timestamp && originalTime.isEqual(fresh.createdAt);
        });
        for (const entry of survivors) safeBatchUpdate(transaction, entry.ref, entry.update);
        return survivors;
      }, {maxAttempts:1});
      return isActive() ? acknowledged(committed) : [];
    }
    if (!isFirebaseNotFoundError(error)) throw error;
  }

  if (!isActive()) return [];
  // One server refresh excludes deleted targets while keeping the retry atomic.
  // New commands belong to their own queued snapshot, not this recovery batch.
  const ids = new Set(documents.map((document) => document.id));
  const current = await getDocsFromServer(commandQuery);
  return acknowledgeAgentCommands(db, commandQuery,
    current.docs.filter(document => ids.has(document.id)), deviceId, isActive, false);
}

export async function subscribeAgentCommandsWithFirebase(
  input: { deviceId: string; installId: string; onReady?: () => void },
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
  let ready = false;
  let serialized = Promise.resolve();
  let healthTasks = Promise.resolve();
  let unsubscribe: Unsubscribe | undefined;
  const queuedIds = new Set<string>();
  let lastQueuedHealthAction: string | undefined;
  const stop = () => {
    active = false;
    unsubscribe?.();
    unsubscribe = undefined;
    queuedIds.clear();
  };
  const fail = (error: unknown) => {
    if (!active) return;
    stop();
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  unsubscribe = onSnapshot(
    commandQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      if (!active) return;
      if (!ready) {
        ready = true;
        try {
          input.onReady?.();
        } catch (error) {
          fail(error);
          return;
        }
      }
      const documents = snapshot.docChanges()
        .filter(change => change.type === "added" && change.doc.id !== AGENT_HEALTH_COMMAND_ID && !queuedIds.has(change.doc.id))
        .map((change) => change.doc);
      for (const document of documents) queuedIds.add(document.id);
      // The fixed health document can change without a new ADDED event.
      const health = snapshot.metadata?.fromCache ? undefined : snapshot.docs.find(document =>
        document.id === AGENT_HEALTH_COMMAND_ID && !document.metadata?.hasPendingWrites);
      if (health) {
        const action = String(health.data().action ?? "");
        if (action !== lastQueuedHealthAction) {
          lastQueuedHealthAction = action;
          healthTasks = healthTasks.then(async () => {
            if (!active) return;
            const command = await acknowledgeAgentHealthCommand(services.db, health, input.deviceId, () => active);
            if (active && command) await onCommands([command]);
          }).catch(fail);
        }
      }
      if (documents.length === 0) return;
      serialized = serialized.then(async () => {
        if (!active) return;
        const commands = await acknowledgeAgentCommands(services.db, commandQuery, documents, input.deviceId, () => active);
        if (active && commands.length > 0) {
          await onCommands(orderAgentCommands(commands));
        }
      }).catch(fail).finally(() => {
        for (const document of documents) queuedIds.delete(document.id);
      });
    },
    fail,
  );
  if (!active) stop();
  return stop;
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
  const session = selectRecoverableAgentSession(snapshot.docs.map((sessionDoc) => ({
    id: sessionDoc.id,
    startedAtMs: sessionStartedAtMs(sessionDoc.data() as Record<string, unknown>),
  })));
  return session ? [{ id: session.id, deviceId: input.deviceId }] : [];
}

export async function postSessionTilesWithFirebase(
  sessionId: string,
  input: { tiles: any[]; width: number; height: number; sequence?: number; keyframe?: boolean; cursorEmbedded?: boolean },
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
    ...(typeof input.cursorEmbedded === "boolean" ? {cursorEmbedded:input.cursorEmbedded} : {}),
    ...(Number.isSafeInteger(input.sequence) ? { sequence: input.sequence } : {}),
    createdAt: serverTimestamp(),
  });
}

export async function startAgentWebRtcTransportWithFirebase(
  sessionId: string,
  handlers: AgentWebRtcTransportHandlers = {},
  env: AgentFirebaseEnv = process.env,
): Promise<AgentWebRtcTransport> {
  const services = getAgentFirebaseServices(env);
  const signalRef = doc(services.db, "sessions", sessionId, "webrtc", "signal");
  const connectTimeoutMs = resolveWebRtcConnectTimeoutMs(env);
  const agentCandidates = collection(services.db, "sessions", sessionId, "agentCandidates");
  const viewerCandidates = collection(services.db, "sessions", sessionId, "viewerCandidates");
  const recentViewerCandidates = query(
    viewerCandidates,
    orderBy("createdAt", "desc"),
    limit(MAX_RECENT_WEBRTC_CANDIDATES),
  );
  const recentNegotiationIds = new Set<string>();
  const appliedViewerCandidates = new Set<string>();
  let latestViewerCandidateDocs: readonly { id: string; data: () => Record<string, any> }[] = [];
  let viewerCandidatesFromServer = false;
  const maxMessageBytes = resolveWebRtcMaxMessageBytes(env);
  const preserveUnavailableOnSaturation = resolveFirestoreTileFallbackPolicy(env).enabled;
  let activeNegotiationId: string | null = null;
  let activePeer: AgentPeerConnectionLike | null = null;
  let activeRemoteDescriptionSet = false;
  let tileChannel: AgentDataChannelLike | null = null;
  let controlChannel: AgentDataChannelLike | null = null;
  let fileChannel: AgentDataChannelLike | null = null;
  let fileChannelTasks: AgentDataChannelTaskQueue | null = null;
  let fileSender: ReturnType<typeof createFileChannelSender> | null = null;
  let channelOpened = false;
  let closedByCaller = false;
  let receivedOffer = false;
  let watchingCandidates = false;
  let initialOfferWatchdog: ReturnType<typeof setTimeout> | null = null;
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeSignal: Unsubscribe | null = null;
  let signalListenerGeneration = 0;
  let unsubscribeViewerCandidates: Unsubscribe | null = null;
  let viewerCandidateListenerGeneration = 0;
  let recoverViewerCandidates: (() => void) | undefined;
  let signalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let viewerCandidateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let signalRetryAttempt = 0;
  let viewerCandidateRetryAttempt = 0;
  let pendingOffer: NonNullable<ReturnType<typeof parseAgentWebRtcOffer>> | undefined;
  let negotiating = false;
  let answerGathering: AbortController | null = null;
  let rtcConfiguration: ReturnType<typeof resolveRtcConfiguration> | undefined;

  const clearInitialOfferWatchdog = () => {
    if (!initialOfferWatchdog) return;
    clearTimeout(initialOfferWatchdog);
    initialOfferWatchdog = null;
  };

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
    answerGathering?.abort();
    clearConnectWatchdog();
    const previousTileChannel = tileChannel;
    fileSender?.close();
    fileSender = null;
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
    recoverViewerCandidates = undefined;
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
    onRejected?: () => void,
  ) => {
    const negotiationId = activeNegotiationId;
    const peer = activePeer;
    if (!negotiationId || !peer || !activeRemoteDescriptionSet) {
      return false;
    }
    let matched = false;
    for (const candidateDoc of docs) {
      const candidateData = candidateDoc.data();
      if (!candidateMatchesNegotiation(candidateData, negotiationId)) continue;
      const line = candidateData.candidate.candidate;
      // Werift may silently ignore unsupported types or an unresolved mDNS host.
      const endpoint = typeof line === "string" && /^candidate:[\w+/]{1,32} +[12] +(?:udp|tcp) +\d{1,10} +(\S+) +([1-9]\d{0,4}) +typ +(?:host|srflx|relay)(?: +|$)/i.exec(line.trim());
      if (endpoint && isIP(endpoint[1]) && Number(endpoint[2]) <= 65535) matched = true;
      const candidateKey = `${negotiationId}:${candidateDoc.id}`;
      if (appliedViewerCandidates.has(candidateKey)) continue;
      appliedViewerCandidates.add(candidateKey);
      void peer.addIceCandidate(candidateData.candidate).catch((error: unknown) => {
        appliedViewerCandidates.delete(candidateKey);
        console.warn(`[WebRTC] Failed to add Viewer ICE candidate: ${error instanceof Error ? error.message : error}`);
        onRejected?.();
      });
    }
    return matched;
  };

  const activateNegotiation = async (offer: NonNullable<ReturnType<typeof parseAgentWebRtcOffer>>) => {
    if (closedByCaller) return;

    handlers.onState?.("negotiating");
    await closeActivePeer();
    if (closedByCaller) {
      return;
    }

    activeNegotiationId = offer.negotiationId;
    activeRemoteDescriptionSet = false;
    channelOpened = false;
    const configuration = await (rtcConfiguration ??= resolveRtcConfiguration(env, async () =>
      httpsCallable(services.functions, "getRtcConfiguration")({}),
    ).catch(error => { rtcConfiguration = undefined; throw error; }));
    if (closedByCaller || activeNegotiationId !== offer.negotiationId) return;
    if (!watchingCandidates) {
      watchingCandidates = true;
      subscribeViewerCandidateUpdates();
    }
    const peer = await createAgentPeerConnection({
      iceServers: configuration.iceServers,
      iceTransportPolicy: configuration.iceTransportPolicy,
    });
    if (closedByCaller || activeNegotiationId !== offer.negotiationId) {
      await peer.close();
      return;
    }
    activePeer = peer;
    const canPublishAnswer = () => !closedByCaller && activePeer === peer
      && activeNegotiationId === offer.negotiationId && !pendingOffer;

    peer.onicecandidate = (event) => {
      if (!event.candidate || !canPublishAnswer()) {
        return;
      }
      const candidate = event.candidate.toJSON?.() ?? event.candidate;
      void safeAddDoc(agentCandidates, {
        candidate,
        createdAt: serverTimestamp(),
        negotiationId: offer.negotiationId,
      }).catch((error) => {
        console.warn(
          `[WebRTC] Agent ICE candidate write failed; remaining candidates will continue: ${error instanceof Error ? error.message : error}`,
        );
      });
    };

    peer.ondatachannel = (event) => {
      if (closedByCaller || activePeer !== peer || activeNegotiationId !== offer.negotiationId) {
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
              if (closedByCaller || activePeer !== peer || tileChannel !== channel || activeNegotiationId !== offer.negotiationId) {
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
          const isCurrentChannel = (requireOpen = false) => !(
            closedByCaller ||
            activeNegotiationId !== offer.negotiationId ||
            controlChannel !== channel ||
            (requireOpen && channel.readyState !== "open")
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
            handlers.onControlClosed?.(isCurrentChannel);
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
          const sender = createFileChannelSender(channel);
          fileSender = sender;
          const tasks = bindAgentFileMessages(channel, {
            onAck: (ack) => sender.acknowledge(ack),
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
            sender.close();
            if (fileSender === sender) fileSender = null;
            tasks.close();
            if (fileChannelTasks === tasks) {
              fileChannelTasks = null;
            }
            if (fileChannel === channel) {
              fileChannel = null;
            }
          };
          let capabilitySent = false;
          channel.onopen = () => {
            if (capabilitySent || closedByCaller || fileChannel !== channel || activeNegotiationId !== offer.negotiationId || channel.readyState !== "open") return;
            try {
              if (!channel.send) return;
              channel.send(WEBRTC_REVERSE_FILE_CAPABILITY);
              capabilitySent = true;
            } catch { console.warn("[WebRTC] Could not advertise reverse file support."); }
          };
          if (channel.readyState === "open") channel.onopen();
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
      if (closedByCaller || activePeer !== peer || activeNegotiationId !== offer.negotiationId) {
        return;
      }
      const state = String(peer.connectionState ?? "");
      if (isTerminalWebRtcConnectionState(state)) {
        failNegotiation(offer.negotiationId, state);
      }
    };

    await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    if (closedByCaller || activePeer !== peer || activeNegotiationId !== offer.negotiationId) return;
    activeRemoteDescriptionSet = true;
    let fallbackStarted = false;
    const refreshCandidates = () => {
      if (fallbackStarted || !canPublishAnswer()) return;
      fallbackStarted = true;
      void getDocs(recentViewerCandidates)
        .then(snapshot => { if (canPublishAnswer()) applyViewerCandidateDocs(snapshot.docs); })
        .catch(error => {
          console.warn(`[WebRTC] Viewer ICE candidate refresh failed; realtime listener will continue: ${error instanceof Error ? error.message : error}`);
        });
    };
    recoverViewerCandidates = refreshCandidates;
    const matched = applyViewerCandidateDocs(latestViewerCandidateDocs, refreshCandidates);
    if (!viewerCandidatesFromServer || !matched) refreshCandidates();
    const answer = await peer.createAnswer();
    if (!canPublishAnswer()) return;
    const gathering = new AbortController();
    answerGathering = gathering;
    try {
      await publishAnswerDuringGathering(peer, answer, async localAnswer => {
        await safeSetDoc(
          signalRef,
          {
            answer: {
              negotiationId: offer.negotiationId,
              type: localAnswer.type,
              sdp: localAnswer.sdp,
            },
            state: "agent-answer",
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }, canPublishAnswer, gathering.signal);
    } finally {
      answerGathering = null;
    }
    if (!canPublishAnswer()) return;
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
    if (!offer || closedByCaller || !rememberNegotiationAttempt(recentNegotiationIds, offer.negotiationId)) {
      return;
    }
    if (!receivedOffer) {
      receivedOffer = true;
      clearInitialOfferWatchdog();
    }
    pendingOffer = offer;
    answerGathering?.abort();
    if (negotiating) return;
    negotiating = true;
    void (async () => {
      try {
        while (!closedByCaller && pendingOffer) {
          const next = pendingOffer;
          pendingOffer = undefined;
          try {
            await activateNegotiation(next);
          } catch (error) {
            reportTransportError("negotiation-failed", error instanceof Error ? error.message : String(error));
            if (!watchingCandidates) {
              await closeTransport();
              return;
            }
            if (activeNegotiationId) await closeActivePeer(activeNegotiationId);
          }
        }
      } finally {
        negotiating = false;
      }
    })();
  };

  const scheduleSignalResubscribe = (error: unknown) => {
    console.warn(
      `[WebRTC] Signal listener failed after initial offer; resubscribing: ${error instanceof Error ? error.message : error}`,
    );
    if (closedByCaller || signalRetryTimer) {
      return;
    }
    const delayMs = webRtcReconnectDelayMs(signalRetryAttempt);
    signalRetryAttempt += 1;
    signalRetryTimer = setTimeout(() => {
      signalRetryTimer = null;
      subscribeSignalUpdates();
    }, delayMs);
  };

  const subscribeSignalUpdates = () => {
    if (closedByCaller) {
      return;
    }
    unsubscribeSignal?.();
    unsubscribeSignal = null;
    const generation = ++signalListenerGeneration;
    const onError = (error: unknown) => {
      if (closedByCaller || generation !== signalListenerGeneration) return;
      signalListenerGeneration++;
      unsubscribeSignal?.();
      unsubscribeSignal = null;
      if (!receivedOffer) {
        reportTransportError("signal-listener-failed", error instanceof Error ? error.message : String(error));
        void closeTransport();
        return;
      }
      scheduleSignalResubscribe(error);
    };
    try {
      const stop = onSnapshot(
        signalRef,
        (snapshot) => {
          if (closedByCaller || generation !== signalListenerGeneration) return;
          signalRetryAttempt = 0;
          scheduleNegotiation(snapshot.data());
        },
        onError,
      );
      if (closedByCaller || generation !== signalListenerGeneration) stop();
      else unsubscribeSignal = stop;
    } catch (error) {
      onError(error);
    }
  };

  const scheduleViewerCandidateResubscribe = (error: unknown) => {
    console.warn(
      `[WebRTC] Viewer ICE candidate listener failed; resubscribing: ${error instanceof Error ? error.message : error}`,
    );
    if (closedByCaller || viewerCandidateRetryTimer) {
      return;
    }
    const delayMs = webRtcReconnectDelayMs(viewerCandidateRetryAttempt);
    viewerCandidateRetryAttempt += 1;
    viewerCandidateRetryTimer = setTimeout(() => {
      viewerCandidateRetryTimer = null;
      subscribeViewerCandidateUpdates();
    }, delayMs);
  };

  const subscribeViewerCandidateUpdates = () => {
    if (closedByCaller) {
      return;
    }
    unsubscribeViewerCandidates?.();
    unsubscribeViewerCandidates = null;
    const generation = ++viewerCandidateListenerGeneration;
    viewerCandidatesFromServer = false;
    const onError = (error: unknown) => {
      if (closedByCaller || generation !== viewerCandidateListenerGeneration) return;
      viewerCandidateListenerGeneration++;
      viewerCandidatesFromServer = false;
      unsubscribeViewerCandidates?.();
      unsubscribeViewerCandidates = null;
      if (!channelOpened) recoverViewerCandidates?.();
      scheduleViewerCandidateResubscribe(error);
    };
    try {
      const stop = onSnapshot(
        recentViewerCandidates,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (closedByCaller || generation !== viewerCandidateListenerGeneration) return;
          viewerCandidateRetryAttempt = 0;
          viewerCandidatesFromServer = snapshot.metadata?.fromCache === false && snapshot.metadata?.hasPendingWrites === false;
          latestViewerCandidateDocs = snapshot.docs;
          applyViewerCandidateDocs(latestViewerCandidateDocs, channelOpened ? undefined : recoverViewerCandidates);
        },
        onError,
      );
      if (closedByCaller || generation !== viewerCandidateListenerGeneration) stop();
      else unsubscribeViewerCandidates = stop;
    } catch (error) {
      onError(error);
    }
  };

  const closeTransport = async () => {
    if (closedByCaller) return;
    closedByCaller = true;
    pendingOffer = undefined;
    clearInitialOfferWatchdog();
    clearConnectWatchdog();
    if (signalRetryTimer) {
      clearTimeout(signalRetryTimer);
      signalRetryTimer = null;
    }
    if (viewerCandidateRetryTimer) {
      clearTimeout(viewerCandidateRetryTimer);
      viewerCandidateRetryTimer = null;
    }
    unsubscribeSignal?.();
    unsubscribeViewerCandidates?.();
    await closeActivePeer();
  };
  initialOfferWatchdog = setTimeout(() => {
    reportTransportError("timeout", `${connectTimeoutMs}ms without a Viewer offer`);
    void closeTransport();
  }, connectTimeoutMs);
  subscribeSignalUpdates();

  return {
    close: closeTransport,
    isClosed: () => closedByCaller,
    getBufferedAmount: () => dataChannelBufferedAmount(tileChannel),
    sendFileStatus: status => {
      if (closedByCaller || !fileChannel?.send || fileChannel.readyState !== "open") return false;
      try { fileChannel.send(serializeWebRtcFileStatus(status)); return true; } catch { return false; }
    },
    sendFile: async (input) => {
      if (!fileSender || closedByCaller) throw new Error("File channel is unavailable.");
      await fileSender.sendFile(input);
    },
    sendFrame: (frame, maxBufferedAmountOverride) => sendFrameWithBackpressure(
      tileChannel,
      frame,
      {
        maxBufferedAmount: resolveAgentFrameMaxBufferedAmount(maxBufferedAmountOverride, env),
        maxMessageBytes,
        preserveUnavailableOnSaturation,
      },
    ),
  };
}

export function subscribeAgentSessionData(
  sessionId: string, onData: (data: import("../domain/sessionData").SessionData) => void | Promise<void>, onError: (error: Error) => void,
  env: AgentFirebaseEnv = process.env,
): Unsubscribe {
  return subscribeFirebaseSessionData(getAgentFirebaseServices(env).db, sessionId, "agent", onData, onError);
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
    collisionPolicy: data.collisionPolicy as import("../domain/fileCollisionPolicy").FileCollisionPolicy | undefined,
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

function hasFirebaseErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isFirebaseNotFoundError(error: unknown): boolean {
  return hasFirebaseErrorCode(error, "not-found");
}
