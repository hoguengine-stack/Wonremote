import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getIdTokenResult,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { deleteObject, ref, uploadBytesResumable } from "firebase/storage";
import type {
  AgentFirstRunInput,
  AgentFirstRunResult,
  ChatMessage,
  ClipboardData,
  ConnectionHistoryEntry,
  DeviceMetadataUpdateInput,
  DeviceUpdateRing,
  FileTransferReceipt,
  ManagedDevice,
  RemoteSession,
  TransferredFile,
} from "../domain/types";
import { normalizeWakeMac, selectViewerWakeRelay } from "../domain/wakeRelay";
import { prepareViewerDeviceList, resolveViewerOfflineAfterMs } from "../domain/viewerDeviceList";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "../domain/deviceDefaults";
import { createFirebaseSessionId, mapFirebaseSessionHistory } from "../domain/firebaseSession";
import {
  resolveRtcConfiguration,
  viewerTileDataChannelOptions,
} from "../domain/rtcTransport";
import {
  serializeWebRtcControlAction,
  WEBRTC_CONTROL_CHANNEL_LABEL,
  WEBRTC_TILE_CHANNEL_LABEL,
} from "../domain/webrtcControl";
import {
  parseWebRtcFileAck,
  serializeWebRtcFileChunk,
  WEBRTC_FILE_ACK_TIMEOUT_MS,
  WEBRTC_FILE_CHANNEL_LABEL,
  WEBRTC_FILE_CHUNK_BYTES,
  WEBRTC_FILE_WINDOW_CHUNKS,
  type WebRtcFileAckMessage,
} from "../domain/webrtcFileTransfer";
import {
  buildSecureChallengeId,
  generateSecurityCode,
  secureChallengeExpiresAt,
} from "../domain/secureSession";
import {
  formatWebRtcConnectionFailure,
  isTerminalWebRtcConnectionState,
  resolveWebRtcConnectTimeoutMs,
} from "../domain/webrtcStability";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { WebRtcFrameAssembler, type RemoteTileFrame } from "../domain/webrtcFrameAssembly";
import { buildAgentAuthEmail, buildAgentAuthPassword, buildViewerAuthCredentials } from "./firebaseIdentity";
import { buildFirestoreDevice, mapFirestoreDevice, mergeFirstRunDeviceDocument } from "./firestoreDevice";
import {
  CURRENT_REMOTE_PROTOCOL_VERSION,
  evaluateRemoteProtocolCompatibility,
  remoteProtocolErrorMessage,
} from "../domain/remoteProtocol";
import { getWonRemoteFirebaseServices } from "./firebaseServices";
import { throwExplainedFirebaseAuthError } from "./firebaseError";
import { safeAddDoc, safeBatchSet, safeBatchUpdate, safeSetDoc, safeUpdateDoc } from "./firestoreWrite";
import type { UpdateFleetRollout } from "../domain/updateFleetPolicy";

type ViewerFirebaseEnv = ImportMetaEnv;
export type ViewerFunctionMode = "auto" | "callable" | "direct";

export async function loadFirebaseUpdateRollout(
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<UpdateFleetRollout | null> {
  const services = getViewerFirebaseServices(env);
  const snapshot = await getDoc(doc(services.db, "configuration", "updateRollout"));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as Record<string, unknown>;
  if (typeof data.targetVersion !== "string" || !data.targetVersion.trim()) return null;
  const stage = data.stage === "canary" || data.stage === "pilot" || data.stage === "general" ? data.stage : null;
  if (!stage) return null;
  return {
    targetVersion: data.targetVersion.trim(),
    stage,
    paused: data.paused === true,
    percentage: typeof data.percentage === "number" ? Math.max(0, Math.min(100, Math.trunc(data.percentage))) : 100,
  };
}

export async function saveFirebaseUpdateRollout(
  rollout: UpdateFleetRollout,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await safeSetDoc(doc(services.db, "configuration", "updateRollout"), {
    targetVersion: rollout.targetVersion.trim(),
    stage: rollout.stage,
    paused: rollout.paused === true,
    percentage: Math.max(0, Math.min(100, Math.trunc(rollout.percentage ?? 100))),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function updateFirebaseDeviceRollout(
  deviceId: string,
  updateRing: DeviceUpdateRing,
  updatePaused: boolean,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await safeUpdateDoc(doc(services.db, "devices", deviceId), {
    updatePaused,
    updateRing,
    updatedAt: serverTimestamp(),
  });
}
const AGENT_VIEWER_LOGIN_ERROR = "사업자번호 Agent 계정은 Viewer로 로그인할 수 없습니다. 등록된 Viewer 이메일 계정을 사용해 주세요.";
const CENTRAL_VIEWER_LOGIN_ERROR = "등록된 중앙 Viewer 관리자 계정이 아닙니다.";
const CENTRAL_VIEWER_UIDS = new Set(["Xjjdvk0Nx1eqCvND4yIOHbM53tl1"]);

export interface ViewerAccount {
  uid: string;
  email: string;
  displayName: string;
  disabled: boolean;
  isAdmin: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface ViewerWebRtcTransport {
  close: () => void;
  sendControl: (action: string) => boolean;
  sendFile: (input: {
    file: Blob;
    filename: string;
    fileSha256: string;
    transferId: string;
    purpose?: "file" | "clipboard-image";
    mimeType?: "image/png";
    signal?: AbortSignal;
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
  }) => Promise<boolean>;
}

// Covers the full connection watchdog window even under key repeat and pointer movement.
// Returning false here would mix the ordered WebRTC stream with Firestore fallback writes.
const MAX_PENDING_WEBRTC_CONTROL_ACTIONS = 2_048;

export function isViewerFirebaseEnabled(env: ViewerFirebaseEnv = import.meta.env): boolean {
  return resolveFirebaseConfig(env) !== null;
}

export async function loginViewerWithFirebase(
  username: string,
  password: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  if (isAgentViewerIdentity(username)) {
    throw new Error(AGENT_VIEWER_LOGIN_ERROR);
  }
  const services = getViewerFirebaseServices(env);
  const credentials = buildViewerAuthCredentials(username, password);
  let credential;
  try {
    await setPersistence(services.auth, browserLocalPersistence);
    credential = await signInWithEmailAndPassword(services.auth, credentials.email, credentials.password);
  } catch (error) {
    throwExplainedFirebaseAuthError(error);
  }
  if (!credential || !(await isAuthorizedViewerUser(credential.user))) {
    await signOut(services.auth);
    throw new Error(CENTRAL_VIEWER_LOGIN_ERROR);
  }
}

export function subscribeViewerAuthState(
  onAuthenticated: (isAuthenticated: boolean) => void,
  onError: (error: Error) => void,
  env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  const services = getViewerFirebaseServices(env);
  return onAuthStateChanged(
    services.auth,
    (user) => {
      if (!user) {
        onAuthenticated(false);
        return;
      }
      void isAuthorizedViewerUser(user)
        .then(async (authorized) => {
          if (authorized) {
            onAuthenticated(true);
            return;
          }
          await signOut(services.auth);
          onAuthenticated(false);
          onError(new Error(isAgentViewerIdentity(user.email ?? "")
            ? AGENT_VIEWER_LOGIN_ERROR
            : CENTRAL_VIEWER_LOGIN_ERROR));
        })
        .catch((error) => {
          onAuthenticated(false);
          onError(error instanceof Error ? error : new Error(CENTRAL_VIEWER_LOGIN_ERROR));
        });
    },
    (error) => onError(error),
  );
}

function isAgentViewerIdentity(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^\d{3}-?\d{2}-?\d{5}$/.test(normalized)
    || normalized.endsWith("@agents.wonremote.app");
}

function isCentralViewerUid(uid: string): boolean {
  return CENTRAL_VIEWER_UIDS.has(uid);
}

async function isAuthorizedViewerUser(user: User): Promise<boolean> {
  if (isCentralViewerUid(user.uid)) {
    return true;
  }
  const token = await getIdTokenResult(user, true);
  return token.claims.wonremoteViewer === true;
}

export async function isCurrentViewerAccountManager(
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<boolean> {
  const user = getViewerFirebaseServices(env).auth.currentUser;
  if (!user) return false;
  if (isCentralViewerUid(user.uid)) return true;
  const token = await getIdTokenResult(user, true);
  return token.claims.wonremoteAdmin === true;
}

export async function listViewerAccounts(
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ViewerAccount[]> {
  return callViewerFunction<Record<string, never>, ViewerAccount[]>("listViewerAccounts", {}, env);
}

export async function createViewerAccount(
  input: { email: string; password: string; displayName?: string },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ViewerAccount> {
  return callViewerFunction<typeof input, ViewerAccount>("createViewerAccount", input, env);
}

export async function updateViewerAccount(
  input: { uid: string; displayName?: string; password?: string; disabled?: boolean },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ViewerAccount> {
  return callViewerFunction<typeof input, ViewerAccount>("updateViewerAccount", input, env);
}

export async function deleteViewerAccount(
  uid: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  await callViewerFunction<{ uid: string }, { deleted: boolean }>("deleteViewerAccount", { uid }, env);
}

export async function logoutViewerWithFirebase(env: ViewerFirebaseEnv = import.meta.env): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await signOut(services.auth);
}

export async function requestViewerPasswordReset(
  email: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("아이디(이메일)를 입력해 주세요.");
  }
  if (isAgentViewerIdentity(normalizedEmail)) {
    throw new Error(AGENT_VIEWER_LOGIN_ERROR);
  }
  try {
    await sendPasswordResetEmail(getViewerFirebaseServices(env).auth, normalizedEmail);
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";
    if (code === "auth/user-not-found") {
      return;
    }
    throw new Error("비밀번호 재설정 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

export function subscribeFirebaseDevices(
  onDevices: (devices: ManagedDevice[]) => void,
  onError: (error: Error) => void,
  env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  const services = getViewerFirebaseServices(env);
  requireCurrentUserId(services.auth.currentUser?.uid);
  const devicesCollection = collection(services.db, "devices");

  return onSnapshot(
    devicesCollection,
    (snapshot) => {
      onDevices(prepareViewerDeviceList(
        snapshot.docs
          .filter((deviceDoc) => !isDeletedDeviceDocument(deviceDoc.data()))
          .map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data())),
        new Date().toISOString(),
        resolveViewerOfflineAfterMs(env),
      ));
    },
    (error) => onError(error),
  );
}

export async function fetchFirebaseDevices(env: ViewerFirebaseEnv = import.meta.env): Promise<ManagedDevice[]> {
  const services = getViewerFirebaseServices(env);
  requireCurrentUserId(services.auth.currentUser?.uid);
  const snapshot = await getDocs(collection(services.db, "devices"));
  return prepareViewerDeviceList(
    snapshot.docs
      .filter((deviceDoc) => !isDeletedDeviceDocument(deviceDoc.data()))
      .map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data())),
    new Date().toISOString(),
    resolveViewerOfflineAfterMs(env),
  );
}

export async function fetchFirebaseConnectionHistory(
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ConnectionHistoryEntry[]> {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  const [sessionsSnapshot, devices] = await Promise.all([
    getDocs(query(collection(services.db, "sessions"), where("ownerUid", "==", userId), limit(200))),
    fetchFirebaseDevices(env),
  ]);
  return mapFirebaseSessionHistory(
    sessionsSnapshot.docs.map((sessionDoc) => ({
      id: sessionDoc.id,
      data: sessionDoc.data(),
    })),
    devices,
  );
}

export async function updateFirebaseDeviceMetadata(
  deviceId: string,
  input: Omit<DeviceMetadataUpdateInput, "deviceId">,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ManagedDevice> {
  const services = getViewerFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", deviceId);
  const currentSnapshot = await getDoc(deviceRef);
  if (!currentSnapshot.exists()) {
    throw new Error("Firebase device not found.");
  }
  const currentDevice = mapFirestoreDevice(currentSnapshot.id, currentSnapshot.data());
  const update: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (typeof input.storeName === "string" && input.storeName.trim()) {
    const storeName = normalizeStoreNameForDisplay(input.storeName, currentDevice.businessNumber);
    update.storeName = storeName;
    update.storeNameSource = storeName === DEFAULT_STORE_NAME ? "default" : "user";
  }
  if (typeof input.deviceName === "string" && input.deviceName.trim()) {
    update.deviceName = input.deviceName.trim();
  }
  if (typeof input.desktopName === "string" && input.desktopName.trim()) {
    update.desktopName = input.desktopName.trim();
  }

  await safeUpdateDoc(deviceRef, update);
  const snapshot = await getDoc(deviceRef);
  if (!snapshot.exists()) {
    throw new Error("Firebase device not found.");
  }
  return mapFirestoreDevice(snapshot.id, snapshot.data());
}

export async function deleteFirebaseDevice(
  deviceId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  const user = services.auth.currentUser;
  if (!user || !(await isAuthorizedViewerUser(user))) {
    throw new Error("Only the central Viewer can delete devices.");
  }

  const deviceRef = doc(services.db, "devices", deviceId);
  const deviceSnapshot = await getDoc(deviceRef);
  if (!deviceSnapshot.exists()) {
    return;
  }

  const commandSnapshot = await getDocs(collection(services.db, "devices", deviceId, "commands"));
  const references = commandSnapshot.docs.map((commandDoc) => commandDoc.ref);
  const maxBatchDeletes = 450;

  if (references.length === 0) {
    const batch = writeBatch(services.db);
    safeBatchUpdate(batch, deviceRef, {
      deletedAt: serverTimestamp(),
      status: "offline",
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
    return;
  }

  for (let offset = 0; offset < references.length; offset += maxBatchDeletes) {
    const batch = writeBatch(services.db);
    references.slice(offset, offset + maxBatchDeletes).forEach((reference) => batch.delete(reference));
    if (offset + maxBatchDeletes >= references.length) {
      safeBatchUpdate(batch, deviceRef, {
        deletedAt: serverTimestamp(),
        status: "offline",
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }
}

function isDeletedDeviceDocument(data: Record<string, unknown>): boolean {
  return data.deletedAt !== undefined && data.deletedAt !== null;
}

export async function registerFirstRunAgentWithFirebase(
  input: AgentFirstRunInput,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<AgentFirstRunResult> {
  const services = getViewerFirebaseServices(env);
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

  const device = buildFirestoreDevice({
    businessNumber: input.businessNumber,
    desktopName: input.desktopName,
    installId: input.installId,
    nowIso: new Date().toISOString(),
    ownerUid: credential.user.uid,
    protocolVersion: input.protocolVersion,
    version: input.version,
  });
  const deviceRef = doc(services.db, "devices", device.id);
  const existingSnapshot = await getDoc(deviceRef);
  const deviceDocument = mergeFirstRunDeviceDocument(
    device,
    existingSnapshot.exists() ? existingSnapshot.data() : undefined,
    Boolean(input.desktopName?.trim()),
  );

  await safeSetDoc(
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

  const resultDevice = mapFirestoreDevice(device.id, deviceDocument);
  return {
    devices: [resultDevice],
    device: resultDevice,
  };
}

export async function openFirebaseSession(
  deviceId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  return callViewerFunctionWithFirestoreFallback<
    { deviceId: string },
    { session: RemoteSession; inputLog: string[] }
  >("openSession", { deviceId }, env, () => openFirebaseSessionDirect(deviceId, env));
}

export async function wakeFirebaseDevice(
  targetDeviceId: string,
  targetMac: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ relayDeviceId: string; targetDeviceId: string; targetMac: string }> {
  return callViewerFunctionWithFirestoreFallback<
    { targetDeviceId: string; targetMac: string },
    { relayDeviceId: string; targetDeviceId: string; targetMac: string }
  >("wakeDevice", { targetDeviceId, targetMac }, env, () => wakeFirebaseDeviceDirect(targetDeviceId, targetMac, env));
}

export async function requestFirebaseSecureSession(
  deviceId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ challengeId: string; expiresAt: string }> {
  return callViewerFunctionWithFirestoreFallback<
    { deviceId: string },
    { challengeId: string; expiresAt: string }
  >("requestSecureSession", { deviceId }, env, () => requestFirebaseSecureSessionDirect(deviceId, env));
}

export async function connectFirebaseSecureSession(
  input: { challengeId: string; code: string; deviceId: string },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  return callViewerFunctionWithFirestoreFallback<
    { challengeId: string; code: string; deviceId: string },
    { session: RemoteSession; inputLog: string[] }
  >("connectSecureSession", input, env, () => connectFirebaseSecureSessionDirect(input, env));
}

export async function recordFirebaseInput(
  sessionId: string,
  action: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<string[]> {
  const result = await callViewerFunctionWithFirestoreFallback<
    { action: string; sessionId: string },
    { inputLog: string[] }
  >("enqueueCommand", { action, sessionId }, env, () => recordFirebaseInputDirect(sessionId, action, env));
  return result.inputLog;
}

export async function closeFirebaseSession(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  await callViewerFunctionWithFirestoreFallback<{ sessionId: string }, null>(
    "closeSession",
    { sessionId },
    env,
    () => closeFirebaseSessionDirect(sessionId, env),
  );
}

export async function sendFirebaseChatMessage(
  sessionId: string,
  message: string,
  sender: "viewer" | "agent",
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await safeAddDoc(collection(services.db, "sessions", sessionId, "chat"), {
    message,
    sender,
    target: oppositeSessionSender(sender),
    createdAt: serverTimestamp(),
  });
}

export async function fetchFirebaseChatMessages(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ChatMessage[]> {
  return drainFirebaseSessionQueue(sessionId, "chat", 100, "viewer", (id, data) => ({
    id,
    message: String(data.message ?? ""),
    sender: data.sender === "agent" ? "agent" : "viewer",
    createdAt: coerceCreatedAt(data.createdAt),
  }), env);
}

export async function sendFirebaseClipboardText(
  sessionId: string,
  text: string,
  sender: "viewer" | "agent",
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await safeAddDoc(collection(services.db, "sessions", sessionId, "clipboard"), {
    text,
    sender,
    target: oppositeSessionSender(sender),
    createdAt: serverTimestamp(),
  });
}

export async function fetchFirebaseClipboardText(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ClipboardData[]> {
  return drainFirebaseSessionQueue(sessionId, "clipboard", 100, "viewer", (_id, data) => ({
    text: String(data.text ?? ""),
    sender: data.sender === "agent" ? "agent" : "viewer",
  }), env);
}

export async function uploadFirebaseFileChunk(
  sessionId: string,
  input: Omit<TransferredFile, "id">,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await safeAddDoc(collection(services.db, "sessions", sessionId, "files"), {
    ...input,
    delivery: "firestore-direct",
    sender: "viewer",
    target: "agent",
    createdAt: serverTimestamp(),
  });
}

export async function uploadFirebaseFileToStorage(
  sessionId: string,
  input: {
    file: Blob;
    filename: string;
    transferId: string;
    totalBytes: number;
    fileSha256?: string;
    signal?: AbortSignal;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
  },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ storagePath: string }> {
  const services = getViewerFirebaseServices(env);
  const storagePath = [
    "sessions",
    safeStorageSegment(sessionId),
    "files",
    safeStorageSegment(input.transferId),
    safeStorageSegment(input.filename),
  ].join("/");
  const storageRef = ref(services.storage, storagePath);
  const uploadTask = uploadBytesResumable(storageRef, input.file, {
    contentType: input.file.type || "application/octet-stream",
    customMetadata: {
      filename: input.filename,
      sessionId,
      transferId: input.transferId,
    },
  });

  if (input.signal?.aborted) {
    uploadTask.cancel();
    throw new DOMException("File transfer cancelled.", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const cancelUpload = () => uploadTask.cancel();
    input.signal?.addEventListener("abort", cancelUpload, { once: true });
    uploadTask.on(
      "state_changed",
      (snapshot) => input.onProgress?.(snapshot.bytesTransferred, snapshot.totalBytes),
      (error) => {
        input.signal?.removeEventListener("abort", cancelUpload);
        reject(input.signal?.aborted ? new DOMException("File transfer cancelled.", "AbortError") : error);
      },
      () => {
        input.signal?.removeEventListener("abort", cancelUpload);
        resolve();
      },
    );
  });

  if (input.signal?.aborted) {
    await deleteObject(uploadTask.snapshot.ref).catch(() => undefined);
    throw new DOMException("File transfer cancelled.", "AbortError");
  }

  await safeAddDoc(collection(services.db, "sessions", sessionId, "files"), {
    delivery: "firebase-storage",
    fileData: "",
    fileSha256: input.fileSha256,
    filename: input.filename,
    isLast: true,
    sender: "viewer",
    storagePath: uploadTask.snapshot.ref.fullPath,
    target: "agent",
    totalBytes: input.totalBytes,
    totalChunks: 1,
    transferId: input.transferId,
    createdAt: serverTimestamp(),
  });
  return { storagePath: uploadTask.snapshot.ref.fullPath };
}

export async function deleteFirebaseStorageFile(
  storagePath: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await deleteObject(ref(services.storage, storagePath));
}

export async function fetchFirebaseFiles(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<TransferredFile[]> {
  return drainFirebaseSessionQueue(sessionId, "files", 200, "viewer", (id, data) => ({
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
    delivery: data.delivery === "firebase-storage" ? "firebase-storage" : "firestore-direct",
    storagePath: typeof data.storagePath === "string" ? data.storagePath : undefined,
  }), env);
}

export async function fetchFirebaseFileTransferReceipts(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<FileTransferReceipt[]> {
  const services = getViewerFirebaseServices(env);
  const snapshot = await getDocs(collection(services.db, "sessions", sessionId, "fileReceipts"));
  return snapshot.docs.map((receiptDoc) => {
    const data = receiptDoc.data() as Record<string, unknown>;
    return {
      transferId: String(data.transferId ?? receiptDoc.id),
      filename: String(data.filename ?? ""),
      status: data.status === "failed" ? "failed" : data.status === "received" ? "received" : "partial",
      receivedChunks: Number(data.receivedChunks ?? 0),
      totalChunks: Number(data.totalChunks ?? 0),
      receivedBytes: typeof data.receivedBytes === "number" ? data.receivedBytes : undefined,
      savedPath: typeof data.savedPath === "string" ? data.savedPath : undefined,
      error: typeof data.error === "string" ? data.error : undefined,
      updatedAt: coerceCreatedAt(data.updatedAt),
    };
  });
}

export async function fetchFirebaseTiles(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<RemoteTileFrame> {
  const frames = await drainFirebaseSessionQueue(sessionId, "tileFrames", 3, undefined, (_id, data) => ({
    tiles: Array.isArray(data.tiles) ? data.tiles : [],
    width: Number(data.width ?? 0),
    height: Number(data.height ?? 0),
    sequence: typeof data.sequence === "number" ? data.sequence : undefined,
    keyframe: data.keyframe === true,
  }), env);
  return frames.reduce(
    (merged, frame) => ({
      tiles: [...merged.tiles, ...frame.tiles],
      width: frame.width || merged.width,
      height: frame.height || merged.height,
      sequence: frame.sequence ?? merged.sequence,
      keyframe: frame.keyframe || merged.keyframe,
    }),
    { tiles: [] as any[], width: 0, height: 0, sequence: undefined, keyframe: false } as RemoteTileFrame,
  );
}

export async function startFirebaseViewerWebRtcTransport(
  sessionId: string,
  handlers: {
    onFrame: (frame: RemoteTileFrame) => void;
    onState?: (state: string) => void;
    onDiagnostic?: (message: string) => void;
    onError?: (error: Error) => void;
  },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ViewerWebRtcTransport> {
  const services = getViewerFirebaseServices(env);
  const rtcConfiguration = await resolveRtcConfiguration(env, async () =>
    httpsCallable(services.functions, "getRtcConfiguration")({}),
  );
  const peer = new RTCPeerConnection({
    iceServers: rtcConfiguration.iceServers,
    iceTransportPolicy: rtcConfiguration.iceTransportPolicy,
  });
  const signalRef = doc(services.db, "sessions", sessionId, "webrtc", "signal");
  const viewerCandidates = collection(services.db, "sessions", sessionId, "viewerCandidates");
  const agentCandidates = collection(services.db, "sessions", sessionId, "agentCandidates");
  const appliedCandidateIds = new Set<string>();
  const applyingCandidateIds = new Set<string>();
  const automaticallyRetriedCandidateIds = new Set<string>();
  const pendingAgentCandidates = new Map<string, RTCIceCandidateInit>();
  const negotiationId = createFirebaseSessionId("rtc");
  let answerApplied = false;
  let answerApplyInFlight = false;
  let channelOpened = false;
  let controlChannelOpened = false;
  let fileChannelOpened = false;
  let closedByCaller = false;
  let resourcesClosed = false;
  let unsubscribeSignal: Unsubscribe | null = null;
  let unsubscribeAgentCandidates: Unsubscribe | null = null;
  let candidateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  let pendingControlActions: string[] = [];
  const frameAssembler = new WebRtcFrameAssembler();
  const fileAckStates = new Map<string, WebRtcFileAckMessage>();
  const fileAckWaiters = new Map<string, Set<{
    minReceivedChunks: number;
    resolve: (ack: WebRtcFileAckMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>();

  const rejectAllFileWaiters = (error: Error) => {
    for (const waiters of fileAckWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    fileAckWaiters.clear();
  };

  const clearConnectWatchdog = () => {
    if (connectWatchdog) {
      clearTimeout(connectWatchdog);
      connectWatchdog = null;
    }
  };

  const closeResources = () => {
    if (resourcesClosed) {
      return;
    }
    resourcesClosed = true;
    clearConnectWatchdog();
    if (candidateRetryTimer) {
      clearTimeout(candidateRetryTimer);
      candidateRetryTimer = null;
    }
    unsubscribeSignal?.();
    unsubscribeAgentCandidates?.();
    try {
      channel.close();
    } catch {
      // best effort cleanup
    }
    try {
      controlChannel.close();
    } catch {
      // best effort cleanup
    }
    try {
      fileChannel.close();
    } catch {
      // best effort cleanup
    }
    rejectAllFileWaiters(new Error("WebRTC file channel closed."));
    pendingControlActions = [];
    pendingAgentCandidates.clear();
    applyingCandidateIds.clear();
    automaticallyRetriedCandidateIds.clear();
    peer.close();
  };

  const reportUnavailable = (reason: string, detail?: string) => {
    if (resourcesClosed || closedByCaller) {
      return;
    }
    const message = formatWebRtcConnectionFailure(reason, detail);
    handlers.onState?.(`webrtc-unavailable: ${message}`);
    handlers.onError?.(new Error(message));
    closeResources();
  };

  const reportDiagnostic = (reason: string, detail?: string) => {
    if (resourcesClosed || closedByCaller) {
      return;
    }
    handlers.onDiagnostic?.(formatWebRtcConnectionFailure(reason, detail));
  };

  function schedulePendingAgentCandidateRetry(candidateId: string) {
    if (
      resourcesClosed ||
      closedByCaller ||
      automaticallyRetriedCandidateIds.has(candidateId)
    ) {
      return;
    }
    automaticallyRetriedCandidateIds.add(candidateId);
    if (candidateRetryTimer) {
      return;
    }
    candidateRetryTimer = setTimeout(() => {
      candidateRetryTimer = null;
      flushPendingAgentCandidates();
    }, 50);
  }

  function flushPendingAgentCandidates() {
    if (!answerApplied || resourcesClosed || closedByCaller) {
      return;
    }
    for (const [candidateId, candidate] of pendingAgentCandidates) {
      if (appliedCandidateIds.has(candidateId) || applyingCandidateIds.has(candidateId)) {
        continue;
      }
      applyingCandidateIds.add(candidateId);
      void peer
        .addIceCandidate(candidate)
        .then(() => {
          if (resourcesClosed) {
            return;
          }
          pendingAgentCandidates.delete(candidateId);
          appliedCandidateIds.add(candidateId);
        })
        .catch((error) => {
          reportDiagnostic(
            "agent-candidate-rejected",
            error instanceof Error ? error.message : String(error),
          );
          schedulePendingAgentCandidateRetry(candidateId);
        })
        .finally(() => {
          applyingCandidateIds.delete(candidateId);
        });
    }
  }

  const channel = peer.createDataChannel(WEBRTC_TILE_CHANNEL_LABEL, viewerTileDataChannelOptions());
  const controlChannel = peer.createDataChannel(WEBRTC_CONTROL_CHANNEL_LABEL, { ordered: true });
  const fileChannel = peer.createDataChannel(WEBRTC_FILE_CHANNEL_LABEL, { ordered: true });
  const markConnectionReady = () => {
    if (!channelOpened || !controlChannelOpened) {
      return;
    }
    clearConnectWatchdog();
    handlers.onState?.("webrtc-open");
  };
  controlChannel.onopen = () => {
    controlChannelOpened = true;
    const queued = pendingControlActions;
    pendingControlActions = [];
    try {
      for (const payload of queued) {
        controlChannel.send(payload);
      }
    } catch (error) {
      reportUnavailable("control-channel-send-failed", error instanceof Error ? error.message : String(error));
      return;
    }
    handlers.onState?.("webrtc-control-open");
    markConnectionReady();
  };
  controlChannel.onclose = () => {
    controlChannelOpened = false;
    if (!closedByCaller && !resourcesClosed) {
      handlers.onState?.("webrtc-control-closed");
      reportUnavailable("control-channel-closed");
    }
  };
  controlChannel.onerror = () => {
    controlChannelOpened = false;
    reportUnavailable("control-channel-error", "Viewer WebRTC control channel failed.");
  };
  fileChannel.onopen = () => {
    fileChannelOpened = true;
    handlers.onState?.("webrtc-file-open");
  };
  fileChannel.onclose = () => {
    fileChannelOpened = false;
    rejectAllFileWaiters(new Error("WebRTC file channel closed during transfer."));
    if (!closedByCaller && !resourcesClosed) {
      handlers.onState?.("webrtc-file-closed");
    }
  };
  fileChannel.onerror = () => {
    fileChannelOpened = false;
    const error = new Error("Viewer WebRTC file channel failed.");
    rejectAllFileWaiters(error);
    reportDiagnostic("file-channel-error", error.message);
  };
  fileChannel.onmessage = (event) => {
    const ack = parseWebRtcFileAck(event.data);
    if (!ack) {
      return;
    }
    fileAckStates.set(ack.transferId, ack);
    const waiters = fileAckWaiters.get(ack.transferId);
    if (!waiters) {
      return;
    }
    for (const waiter of [...waiters]) {
      if (ack.status === "error") {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(new Error(ack.error || "Agent rejected the WebRTC file transfer."));
      } else if (ack.receivedChunks >= waiter.minReceivedChunks) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(ack);
      }
    }
    if (waiters.size === 0) {
      fileAckWaiters.delete(ack.transferId);
    }
  };
  channel.onopen = () => {
    channelOpened = true;
    handlers.onState?.("webrtc-tiles-open");
    markConnectionReady();
  };
  channel.onclose = () => {
    if (closedByCaller || resourcesClosed) {
      return;
    }
    handlers.onState?.("webrtc-closed");
    reportUnavailable(channelOpened ? "data-channel-closed" : "closed-before-open");
  };
  channel.onerror = () => reportUnavailable("data-channel-error", "Viewer WebRTC data channel failed.");
  channel.onmessage = (event) => {
    for (const frame of frameAssembler.push(event.data)) {
      handlers.onFrame(frame);
    }
  };

  peer.onconnectionstatechange = () => {
    if (closedByCaller || resourcesClosed) {
      return;
    }
    const state = peer.connectionState;
    handlers.onState?.(`webrtc-${state}`);
    if (isTerminalWebRtcConnectionState(state)) {
      reportUnavailable(state);
    }
  };
  peer.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    void safeAddDoc(viewerCandidates, {
      candidate: event.candidate.toJSON(),
      createdAt: serverTimestamp(),
      negotiationId,
    }).catch((error) => reportDiagnostic(
      "viewer-candidate-write-failed",
      error instanceof Error ? error.message : String(error),
    ));
  };

  unsubscribeSignal = onSnapshot(
    signalRef,
    (snapshot) => {
      const signal = snapshot.data();
      const answer = signal?.answer as { type?: unknown; sdp?: unknown; negotiationId?: unknown } | undefined;
      const answerNegotiationId = answer?.negotiationId ?? signal?.negotiationId;
      if (
        answerApplied ||
        answerApplyInFlight ||
        answerNegotiationId !== negotiationId ||
        answer?.type !== "answer" ||
        typeof answer.sdp !== "string"
      ) {
        return;
      }
      answerApplyInFlight = true;
      void peer
        .setRemoteDescription({ type: "answer", sdp: answer.sdp })
        .then(() => {
          answerApplyInFlight = false;
          if (resourcesClosed || closedByCaller) {
            return;
          }
          answerApplied = true;
          flushPendingAgentCandidates();
        })
        .catch((error) => reportUnavailable(
          "answer-apply-failed",
          error instanceof Error ? error.message : String(error),
        ))
        .finally(() => {
          answerApplyInFlight = false;
        });
    },
    (error) => {
      if (answerApplied || answerApplyInFlight) {
        reportDiagnostic("signal-listener-failed-after-answer", error.message);
      } else {
        reportUnavailable("signal-listener-failed", error.message);
      }
    },
  );

  unsubscribeAgentCandidates = onSnapshot(
    agentCandidates,
    (snapshot) => {
      snapshot.docs.forEach((candidateDoc) => {
        if (
          appliedCandidateIds.has(candidateDoc.id) ||
          applyingCandidateIds.has(candidateDoc.id) ||
          pendingAgentCandidates.has(candidateDoc.id)
        ) {
          return;
        }
        const candidateData = candidateDoc.data();
        if (candidateData.negotiationId !== negotiationId) {
          appliedCandidateIds.add(candidateDoc.id);
          return;
        }
        const candidate = candidateData.candidate;
        if (candidate) {
          pendingAgentCandidates.set(candidateDoc.id, candidate as RTCIceCandidateInit);
        } else {
          appliedCandidateIds.add(candidateDoc.id);
        }
      });
      flushPendingAgentCandidates();
    },
    (error) => reportDiagnostic("agent-candidate-listener-failed", error.message),
  );

  const connectTimeoutMs = resolveWebRtcConnectTimeoutMs(env);
  connectWatchdog = setTimeout(() => {
    reportUnavailable("timeout", `${connectTimeoutMs}ms without open tile and control channels`);
  }, connectTimeoutMs);

  void (async () => {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const localOffer = peer.localDescription ?? offer;
    await safeSetDoc(
      signalRef,
      {
        offer: {
          negotiationId,
          type: localOffer.type,
          sdp: localOffer.sdp,
        },
        negotiationId,
        state: "viewer-offer",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    if (resourcesClosed || closedByCaller) {
      return;
    }
    handlers.onState?.("webrtc-offer-sent");
  })().catch((error) => {
    reportUnavailable("offer-failed", error instanceof Error ? error.message : String(error));
  });

  const waitForFileAck = (transferId: string, minReceivedChunks: number): Promise<WebRtcFileAckMessage> => {
    const current = fileAckStates.get(transferId);
    if (current?.status === "error") {
      return Promise.reject(new Error(current.error || "Agent rejected the WebRTC file transfer."));
    }
    if (current && current.receivedChunks >= minReceivedChunks) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      const waiters = fileAckWaiters.get(transferId) ?? new Set();
      const waiter = {
        minReceivedChunks,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            fileAckWaiters.delete(transferId);
          }
          reject(new Error(`WebRTC file acknowledgement timed out at chunk ${minReceivedChunks}.`));
        }, WEBRTC_FILE_ACK_TIMEOUT_MS),
      };
      waiters.add(waiter);
      fileAckWaiters.set(transferId, waiters);
    });
  };

  const sendFile = async (input: {
    file: Blob;
    filename: string;
    fileSha256: string;
    transferId: string;
    purpose?: "file" | "clipboard-image";
    mimeType?: "image/png";
    signal?: AbortSignal;
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
  }): Promise<boolean> => {
    if (!fileChannelOpened || fileChannel.readyState !== "open") {
      return false;
    }
    const totalChunks = Math.max(1, Math.ceil(input.file.size / WEBRTC_FILE_CHUNK_BYTES));
    fileAckStates.delete(input.transferId);
    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        if (input.signal?.aborted) {
          throw new DOMException("File transfer cancelled.", "AbortError");
        }
        if (!fileChannelOpened || fileChannel.readyState !== "open") {
          throw new Error("WebRTC file channel closed during transfer.");
        }
        const start = chunkIndex * WEBRTC_FILE_CHUNK_BYTES;
        const end = Math.min(input.file.size, start + WEBRTC_FILE_CHUNK_BYTES);
        const chunkBuffer = await input.file.slice(start, end).arrayBuffer();
        fileChannel.send(serializeWebRtcFileChunk({
          type: "file-chunk",
          transferId: input.transferId,
          filename: input.filename,
          chunkIndex,
          totalChunks,
          totalBytes: input.file.size,
          isLast: chunkIndex === totalChunks - 1,
          fileData: arrayBufferToBase64(chunkBuffer),
          chunkSha256: await sha256ArrayBufferHex(chunkBuffer),
          ...(chunkIndex === totalChunks - 1 ? { fileSha256: input.fileSha256 } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        }));

        const sentChunks = chunkIndex + 1;
        if (sentChunks % WEBRTC_FILE_WINDOW_CHUNKS === 0 || sentChunks === totalChunks) {
          const ack = await waitForFileAck(input.transferId, sentChunks);
          if (input.signal?.aborted) {
            throw new DOMException("File transfer cancelled.", "AbortError");
          }
          input.onProgress?.(ack.receivedBytes, input.file.size);
          if (sentChunks === totalChunks && ack.status !== "complete") {
            throw new Error("Agent did not confirm the completed WebRTC file transfer.");
          }
        }
      }
      return true;
    } finally {
      fileAckStates.delete(input.transferId);
    }
  };

  return {
    close: () => {
      closedByCaller = true;
      closeResources();
    },
    sendControl: (action) => {
      if (resourcesClosed || closedByCaller) {
        return false;
      }
      const payload = serializeWebRtcControlAction(action);
      if (!controlChannelOpened || controlChannel.readyState !== "open") {
        if (pendingControlActions.length >= MAX_PENDING_WEBRTC_CONTROL_ACTIONS) {
          reportUnavailable(
            "control-queue-overflow",
            `${MAX_PENDING_WEBRTC_CONTROL_ACTIONS} queued actions before the control channel opened`,
          );
          return false;
        }
        pendingControlActions.push(payload);
        return true;
      }
      try {
        controlChannel.send(payload);
        return true;
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    sendFile,
  };
}

export async function fetchFirebaseSessionStatus(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<"pending" | "connected"> {
  const services = getViewerFirebaseServices(env);
  const snapshot = await getDoc(doc(services.db, "sessions", sessionId));
  if (!snapshot.exists()) {
    throw new Error("Firebase session not found.");
  }
  return snapshot.data().state === "pending" ? "pending" : "connected";
}

async function drainFirebaseSessionQueue<T>(
  sessionId: string,
  queueName: string,
  queueLimit: number,
  target: "viewer" | "agent" | undefined,
  mapItem: (id: string, data: Record<string, unknown>) => T,
  env: ViewerFirebaseEnv,
): Promise<T[]> {
  const services = getViewerFirebaseServices(env);
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

function getViewerFirebaseServices(env: ViewerFirebaseEnv) {
  const config = resolveFirebaseConfig(env);
  if (!config) {
    throw new Error("Firebase config is missing. Set VITE_WONREMOTE_FIREBASE_* values.");
  }
  return getWonRemoteFirebaseServices(config);
}

async function callViewerFunction<TInput extends object, TOutput>(
  name: string,
  input: TInput,
  env: ViewerFirebaseEnv,
): Promise<TOutput> {
  const services = getViewerFirebaseServices(env);
  const callable = httpsCallable<TInput, TOutput>(services.functions, name);
  const result = await callable(input);
  return result.data;
}

async function callViewerFunctionWithFirestoreFallback<TInput extends object, TOutput>(
  name: string,
  input: TInput,
  env: ViewerFirebaseEnv,
  fallback: () => Promise<TOutput>,
): Promise<TOutput> {
  const functionMode = resolveViewerFunctionMode(env);
  if (functionMode === "direct") {
    return fallback();
  }
  try {
    return await callViewerFunction<TInput, TOutput>(name, input, env);
  } catch (error) {
    if (functionMode === "callable" || !shouldUseFirestoreFallback(error)) {
      throw error;
    }
    console.warn(`[Firebase] Cloud Function ${name} unavailable; using Firestore direct fallback.`);
    return fallback();
  }
}

export function resolveViewerFunctionMode(env: Partial<Record<string, string | undefined>>): ViewerFunctionMode {
  const value = env.VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE?.trim().toLowerCase();
  return value === "auto" || value === "callable" ? value : "direct";
}

async function openFirebaseSessionDirect(
  deviceId: string,
  env: ViewerFirebaseEnv,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  await requireFirebaseOnlineCompatibleDeviceDirect(deviceId, env);
  const session = buildConnectedSession(deviceId);
  const batch = writeBatch(services.db);
  safeBatchSet(batch, doc(services.db, "sessions", session.id), {
    ...session,
    ownerUid: userId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
  safeBatchSet(batch, doc(collection(services.db, "devices", deviceId, "commands")), {
    action: `start-stream ${session.id}`,
    createdAt: serverTimestamp(),
    state: "pending",
    sessionId: session.id,
  });
  await batch.commit();
  return {
    inputLog: [`${new Date().toLocaleTimeString()} start-stream queued via Firestore fallback`],
    session,
  };
}

async function requireFirebaseOnlineCompatibleDeviceDirect(
  deviceId: string,
  env: ViewerFirebaseEnv,
): Promise<ManagedDevice> {
  const services = getViewerFirebaseServices(env);
  const deviceSnapshot = await getDoc(doc(services.db, "devices", deviceId));
  if (!deviceSnapshot.exists()) {
    throw new Error("Firebase device not found.");
  }
  const device = mapFirestoreDevice(deviceSnapshot.id, deviceSnapshot.data());
  if (device.status !== "online") {
    throw new Error("Only online agents can accept connections.");
  }
  const protocolDecision = evaluateRemoteProtocolCompatibility(device.protocolVersion);
  if (!protocolDecision.compatible) {
    throw new Error(remoteProtocolErrorMessage(protocolDecision));
  }
  return device;
}

async function wakeFirebaseDeviceDirect(
  targetDeviceId: string,
  targetMac: string,
  env: ViewerFirebaseEnv,
): Promise<{ relayDeviceId: string; targetDeviceId: string; targetMac: string }> {
  const services = getViewerFirebaseServices(env);
  requireCurrentUserId(services.auth.currentUser?.uid);
  const targetSnapshot = await getDoc(doc(services.db, "devices", targetDeviceId));
  if (!targetSnapshot.exists()) {
    throw new Error("Firebase device not found.");
  }
  const target = mapFirestoreDevice(targetSnapshot.id, targetSnapshot.data());
  const normalizedMac = normalizeWakeMac(targetMac);
  const registeredMacs = (target.macAddresses ?? []).map(normalizeWakeMac).filter((mac): mac is string => Boolean(mac));
  if (!normalizedMac || !registeredMacs.includes(normalizedMac)) {
    throw new Error("Wake-on-LAN MAC address is invalid or is not registered to the target device.");
  }

  const deviceSnapshot = await getDocs(collection(services.db, "devices"));
  const relay = selectViewerWakeRelay(
    deviceSnapshot.docs.map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data())),
    { businessNumber: target.businessNumber, nowMs: Date.now(), targetDeviceId },
  );
  if (!relay) {
    throw new Error("같은 업장에 최근 온라인 상태인 Wake-on-LAN 릴레이 Agent가 없습니다.");
  }
  await enqueueFirebaseDeviceCommandDirect(relay.id, `wake-on-lan ${normalizedMac}`, env);
  return { relayDeviceId: relay.id, targetDeviceId, targetMac: normalizedMac };
}

async function requestFirebaseSecureSessionDirect(
  deviceId: string,
  env: ViewerFirebaseEnv,
): Promise<{ challengeId: string; expiresAt: string }> {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  await requireFirebaseOnlineCompatibleDeviceDirect(deviceId, env);

  const nowMs = Date.now();
  const challengeId = buildSecureChallengeId(nowMs);
  const code = generateSecurityCode();
  const expiresAtMs = secureChallengeExpiresAt(nowMs);
  const expiresAt = new Date(expiresAtMs).toISOString();

  await safeSetDoc(doc(services.db, "secureChallenges", challengeId), {
    challengeId,
    code,
    createdAt: serverTimestamp(),
    deviceId,
    expiresAt,
    expiresAtMs,
    ownerUid: userId,
    state: "pending",
    updatedAt: serverTimestamp(),
  });
  await enqueueFirebaseDeviceCommandDirect(deviceId, `security-code ${challengeId} ${code}`, env);

  return { challengeId, expiresAt };
}

async function connectFirebaseSecureSessionDirect(
  input: { challengeId: string; code: string; deviceId: string },
  env: ViewerFirebaseEnv,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  const challengeRef = doc(services.db, "secureChallenges", input.challengeId);
  const challengeSnapshot = await getDoc(challengeRef);
  if (!challengeSnapshot.exists()) {
    throw new Error("Invalid secure connection code.");
  }
  const challenge = challengeSnapshot.data() as {
    code?: unknown;
    deviceId?: unknown;
    expiresAtMs?: unknown;
    ownerUid?: unknown;
    state?: unknown;
  };
  if (challenge.ownerUid !== userId || challenge.deviceId !== input.deviceId || challenge.state !== "pending") {
    throw new Error("Invalid secure connection code.");
  }
  if (typeof challenge.expiresAtMs !== "number" || challenge.expiresAtMs <= Date.now()) {
    await safeUpdateDoc(challengeRef, {
      state: "expired",
      updatedAt: serverTimestamp(),
    });
    throw new Error("Secure connection code expired.");
  }
  if (normalizeSecurityCode(String(challenge.code ?? "")) !== normalizeSecurityCode(input.code)) {
    throw new Error("Invalid secure connection code.");
  }

  await requireFirebaseOnlineCompatibleDeviceDirect(input.deviceId, env);
  await safeUpdateDoc(challengeRef, {
    state: "used",
    updatedAt: serverTimestamp(),
    usedAt: serverTimestamp(),
  });
  return openFirebaseSessionDirect(input.deviceId, env);
}

async function recordFirebaseInputDirect(
  sessionId: string,
  action: string,
  env: ViewerFirebaseEnv,
): Promise<{ inputLog: string[] }> {
  const session = await readOwnedConnectedFirebaseSession(sessionId, env);
  await enqueueFirebaseDeviceCommandDirect(session.deviceId, action, env, sessionId);
  return {
    inputLog: [`${new Date().toLocaleTimeString()} ${action}`],
  };
}

async function closeFirebaseSessionDirect(sessionId: string, env: ViewerFirebaseEnv): Promise<null> {
  const services = getViewerFirebaseServices(env);
  const session = await readOwnedFirebaseSession(sessionId, env);
  await safeUpdateDoc(doc(services.db, "sessions", sessionId), {
    closedAt: serverTimestamp(),
    state: "closed",
    updatedAt: serverTimestamp(),
  });
  await purgePendingFirebaseSessionCommands(session.deviceId, sessionId, env);
  await enqueueFirebaseDeviceCommandDirect(session.deviceId, `stop-stream ${sessionId}`, env, sessionId);
  return null;
}

async function readOwnedConnectedFirebaseSession(
  sessionId: string,
  env: ViewerFirebaseEnv,
): Promise<{ deviceId: string }> {
  const session = await readOwnedFirebaseSession(sessionId, env);
  if (session.state !== "connected") {
    throw new Error("Only connected sessions can send remote input.");
  }
  return session;
}

async function readOwnedFirebaseSession(
  sessionId: string,
  env: ViewerFirebaseEnv,
): Promise<{ deviceId: string; state: string }> {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  const sessionSnapshot = await getDoc(doc(services.db, "sessions", sessionId));
  if (!sessionSnapshot.exists()) {
    throw new Error("Firebase session not found.");
  }
  const session = sessionSnapshot.data() as { deviceId?: unknown; ownerUid?: unknown; state?: unknown };
  if (session.ownerUid !== userId || typeof session.deviceId !== "string") {
    throw new Error("Session is not owned by this Firebase account.");
  }
  return {
    deviceId: session.deviceId,
    state: String(session.state ?? ""),
  };
}

async function enqueueFirebaseDeviceCommandDirect(
  deviceId: string,
  action: string,
  env: ViewerFirebaseEnv,
  sessionId?: string,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await safeAddDoc(collection(services.db, "devices", deviceId, "commands"), {
    action,
    createdAt: serverTimestamp(),
    state: "pending",
    ...(sessionId ? { sessionId } : {}),
  });
}

async function purgePendingFirebaseSessionCommands(
  deviceId: string,
  sessionId: string,
  env: ViewerFirebaseEnv,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  const commandSnapshot = await getDocs(query(
    collection(services.db, "devices", deviceId, "commands"),
    where("sessionId", "==", sessionId),
    where("state", "==", "pending"),
    limit(100),
  ));
  if (commandSnapshot.empty) {
    return;
  }

  const batch = writeBatch(services.db);
  commandSnapshot.docs.forEach((commandDoc) => batch.delete(commandDoc.ref));
  await batch.commit();
}

function buildConnectedSession(deviceId: string): RemoteSession {
  const startedAt = new Date().toISOString();
  return {
    deviceId,
    id: createFirebaseSessionId(deviceId),
    protocolVersion: CURRENT_REMOTE_PROTOCOL_VERSION,
    startedAt,
    state: "connected",
  };
}

export function shouldUseFirestoreFallback(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return [
    "functions/not-found",
    "functions/unimplemented",
    "functions/unavailable",
  ].includes(code) || /cloud function.*(?:not.*found|not available)|functions service unavailable/i.test(message);
}


function normalizeSecurityCode(value: string): string {
  return value.replace(/\D/g, "");
}

async function sha256ArrayBufferHex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebRTC file checksum is unavailable in this runtime.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function safeStorageSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .slice(0, 160) || "item";
}

function requireCurrentUserId(userId: string | undefined): string {
  if (!userId) {
    throw new Error("Firebase viewer is not authenticated.");
  }
  return userId;
}

function isFirebaseAuthCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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
