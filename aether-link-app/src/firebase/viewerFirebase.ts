import { markConnectionTiming } from "../domain/connectionTiming";
import { normalizeZookNumber } from "../domain/zookNumber";
import { DEVICE_ACCESS_TTL_MS, encryptDeviceAccessRequest, type DeviceAccessCredentials, type DeviceAccessOperation } from "../domain/deviceAccessLock";
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
  deleteField,
  deleteDoc,
  doc,
  documentId,
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
  where,
  writeBatch,
  type DocumentReference,
  type Unsubscribe,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { deleteObject, ref, uploadBytesResumable } from "firebase/storage";
import { subscribeFirebaseSessionData } from "./sessionData";
import type { SessionData, SessionDataOptions } from "../domain/sessionData";
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
import {
  DEVICE_CONTACT_NAME_MAX_LENGTH,
  DEVICE_CONTACT_PHONE_MAX_LENGTH,
  DEVICE_INSTALL_LOCATION_MAX_LENGTH,
  DEVICE_NOTES_MAX_LENGTH,
  sanitizeDeviceOperationalMetadataText,
  sanitizeDeviceTags,
} from "../domain/agentRegistry";
import { prepareViewerDeviceList, resolveViewerOfflineAfterMs } from "../domain/viewerDeviceList";
import { collectDevicePresence } from "../domain/devicePresenceRefresh";
import { readViewerGrouping, type ViewerGrouping } from "../domain/viewerGroups";
import { buildSetStreamModeCommand } from "../domain/streamPerformanceMode";
import { DEFAULT_STORE_NAME, normalizeStoreNameForDisplay } from "../domain/deviceDefaults";
import { createFirebaseSessionId, mapFirebaseSessionHistory } from "../domain/firebaseSession";
import { matchEmbeddedViewerIce } from "../domain/viewerOfferIce";
import {
  resolveRtcConfiguration,
  shouldUseDynamicTurnCredentials,
  viewerTileDataChannelOptions,
} from "../domain/rtcTransport";
import {
  serializeWebRtcControlAction,
  WEBRTC_CONTROL_CHANNEL_LABEL,
  WEBRTC_TILE_CHANNEL_LABEL,
} from "../domain/webrtcControl";
import {
  parseWebRtcFileAck,
  isReverseFileCapability,
  supportsReverseFileResume,
  supportsFileCollisionPolicy,
  parseWebRtcFileStatus,
  type WebRtcFileStatusMessage,
  parseWebRtcFileChunk,
  serializeWebRtcFileAck,
  type WebRtcFileChunkMessage,
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
  MAX_RECENT_WEBRTC_CANDIDATES,
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
import { normalizeBusinessNumber } from "../domain/agentRegistry";
import { normalizeAgentMetadataUpdate } from "../domain/agentRegistry";
import type { AgentLocalConfig } from "../agent/agentBootstrap";
import type { UpdateFleetRollout } from "../domain/updateFleetPolicy";
import { parseRolloutSelection } from "../domain/updateFleetPolicy";
import { isHigherVersion } from "../domain/versioning";

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
    ...parseRolloutSelection(data.targetDeviceIds),
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
    stage: rollout.targetDeviceIds !== undefined ? "general" : rollout.stage,
    paused: rollout.paused === true,
    percentage: rollout.targetDeviceIds !== undefined ? 0 : Math.max(0, Math.min(100, Math.trunc(rollout.percentage ?? 100))),
    targetDeviceIds: parseRolloutSelection(rollout.targetDeviceIds).targetDeviceIds ?? null,
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

export function getFirebaseViewerStorageOwner(env: ViewerFirebaseEnv = import.meta.env): string {
  return requireCurrentUserId(getViewerFirebaseServices(env).auth.currentUser?.uid);
}

export interface ViewerWebRtcTransport {
  close: () => void;
  isControlReady: () => boolean;
  sendControl: (action: string) => boolean;
  cancelPointerMove?: () => void;
  sendFile: (input: {
    collisionPolicy?: import("../domain/fileCollisionPolicy").FileCollisionPolicy;
    resume?: boolean;
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

interface ViewerOfferWrite {
  result: Promise<void>;
  failure?: { error: unknown };
  includesCandidate: ReturnType<typeof matchEmbeddedViewerIce>;
}

interface PreparedViewerPeer {
  peer: RTCPeerConnection;
  channels: RTCDataChannel[];
  offer: RTCSessionDescriptionInit;
  candidates: RTCIceCandidate[];
  negotiationId: string;
  offerWrite?: ViewerOfferWrite;
}
const VIEWER_PEER_HANDOFF_MS = 75;
const MAX_PREPARED_VIEWER_PEERS = 32;
// Keep the SDK's ordinary 70s callable window across both TURN attempts.
const VIEWER_RTC_CONFIGURATION_BUDGET_MS = 70_000;
type ViewerPeerPreparation = ReturnType<typeof beginViewerPeerPreparation>;
const openingViewerPeers = new Set<ViewerPeerPreparation>();
const openingViewerReconnects = new Map<AbortController, string>();
const pendingViewerSignals = new Map<string, {ownerUid: string; cancel: () => void}>();
const preparedViewerPeers = new Map<string, ViewerPeerPreparation & {
  services: ReturnType<typeof getViewerFirebaseServices>;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
}>();

function requireActiveViewerReconnect(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
}

async function loadViewerRtcConfiguration(env: ViewerFirebaseEnv, timeout?: number) {
  const services = getViewerFirebaseServices(env);
  return resolveRtcConfiguration(env, async () => httpsCallable(services.functions, "getRtcConfiguration", { timeout })({}));
}

function beginViewerPeerPreparation(env: ViewerFirebaseEnv, ownerUid: string, gatherWhen?: Promise<void>) {
  const configuration = loadViewerRtcConfiguration(env);
  const controller = new AbortController();
  const local: { peer: PreparedViewerPeer | null } = { peer: null };
  const ready = prepareViewerPeer(env, configuration, controller.signal, gatherWhen).then(prepared => local.peer = prepared, () => null);
  let notifyCancellation!: () => void;
  const cancelled = new Promise<null>(resolve => { notifyCancellation = () => resolve(null); });
  return {
    ownerUid, configuration, local, ready, cancelled,
    abandonOffer: () => controller.abort(),
    cancel: () => { controller.abort(); notifyCancellation(); },
  };
}

function queueViewerOffer(
  signalRef: DocumentReference, sessionId: string, negotiationId: string, offer: RTCSessionDescriptionInit,
): ViewerOfferWrite {
  const description = {type:offer.type,sdp:offer.sdp};
  const write = safeSetDoc(signalRef, {
    offer: {negotiationId, ...description},
    negotiationId,
    state: "viewer-offer",
    updatedAt: serverTimestamp(),
  }, {merge:true});
  markConnectionTiming(sessionId, "offer-queued");
  return {result:write,includesCandidate:matchEmbeddedViewerIce(description)};
}

export function queuePreparedFirebaseViewerOffer(sessionId: string): void {
  const pending = preparedViewerPeers.get(sessionId);
  const prepared = pending?.local.peer;
  if (!pending || pending.claimed || !prepared || prepared.offerWrite) return;
  const {db, auth} = pending.services;
  if (auth.currentUser?.uid !== pending.ownerUid) return;
  try {
    const signalRef = doc(db, "sessions", sessionId, "webrtc", "signal");
    const write = queueViewerOffer(signalRef, sessionId, prepared.negotiationId, prepared.peer.localDescription ?? prepared.offer);
    prepared.offerWrite = write;
    // The transport handles the original error; a rejection before mount should not start watches.
    void write.result.catch(error => { write.failure = {error}; });
  } catch {
    // A synchronous setup failure leaves the original mounted path available.
  }
}

function discardPreparedViewerPeer(sessionId: string): void {
  const prepared = preparedViewerPeers.get(sessionId);
  if (!prepared) return;
  preparedViewerPeers.delete(sessionId);
  clearTimeout(prepared.timer);
  prepared.cancel();
}

function discardOtherViewerPreparations(currentUid?: string): void {
  for (const [controller, ownerUid] of openingViewerReconnects) {
    if (ownerUid === currentUid) continue;
    openingViewerReconnects.delete(controller);
    controller.abort();
  }
  for (const pending of openingViewerPeers) {
    if (pending.ownerUid === currentUid) continue;
    openingViewerPeers.delete(pending);
    pending.cancel();
  }
  for (const [id, pending] of preparedViewerPeers) {
    if (pending.ownerUid !== currentUid) discardPreparedViewerPeer(id);
  }
  for (const pending of pendingViewerSignals.values()) {
    if (pending.ownerUid !== currentUid) pending.cancel();
  }
}

async function prepareViewerPeer(
  env: ViewerFirebaseEnv, configuration: ReturnType<typeof loadViewerRtcConfiguration>, signal: AbortSignal,
  gatherWhen?: Promise<void>,
): Promise<PreparedViewerPeer | null> {
  const {iceServers, iceTransportPolicy} = await configuration;
  if (signal.aborted) return null;
  const peer = new RTCPeerConnection({iceServers, iceTransportPolicy});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishAborted!: () => void;
  const aborted = new Promise<void>(resolve => { finishAborted = resolve; });
  const close = () => { clearTimeout(timer); peer.close(); finishAborted(); };
  signal.addEventListener("abort", close, {once:true});
  try {
    const candidates: RTCIceCandidate[] = [];
    peer.onicecandidate = event => { if (event.candidate) candidates.push(event.candidate); };
    const channels = [peer.createDataChannel(WEBRTC_TILE_CHANNEL_LABEL, viewerTileDataChannelOptions()),
      peer.createDataChannel(WEBRTC_CONTROL_CHANNEL_LABEL, {ordered:true}), peer.createDataChannel(WEBRTC_FILE_CHANNEL_LABEL, {ordered:true})];
    const localOffer = peer.createOffer();
    if (gatherWhen) {
      // Authorization time must not consume the existing RTC negotiation budget.
      const permission = Promise.race([gatherWhen, aborted]);
      await Promise.race([permission, localOffer.then(() => permission)]);
      if (signal.aborted) return null;
    }
    await Promise.race([
      localOffer.then(offer => { if (!signal.aborted) return peer.setLocalDescription(offer); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Local RTC preparation timed out.")), resolveWebRtcConnectTimeoutMs(env)); }),
      aborted,
    ]);
    if (signal.aborted) return null;
    const offer = peer.localDescription;
    if (!offer) throw new Error("Local RTC offer unavailable.");
    return {peer,channels,offer,candidates,negotiationId:createFirebaseSessionId("rtc")};
  } catch (error) {
    if (!signal.aborted) close();
    signal.removeEventListener("abort", close);
    throw error;
  }
  finally { clearTimeout(timer); }
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
  onAuthenticated: (isAuthenticated: boolean, uid?: string) => void,
  onError: (error: Error) => void,
  env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  const services = getViewerFirebaseServices(env);
  let active = true;
  let generation = 0;
  let authorizedUid: string | undefined;
  const unsubscribe = onAuthStateChanged(
    services.auth,
    (user) => {
      if (!active) return;
      discardOtherViewerPreparations(user?.uid);
      const current = ++generation;
      if (!user || (authorizedUid && authorizedUid !== user.uid)) {
        authorizedUid = undefined;
        onAuthenticated(false);
      }
      if (!user) return;
      const isCurrent = () => active && current === generation && services.auth.currentUser?.uid === user.uid;
      void isAuthorizedViewerUser(user)
        .then(async (authorized) => {
          if (!isCurrent()) return;
          if (authorized) {
            authorizedUid = user.uid;
            onAuthenticated(true, user.uid);
            return;
          }
          onAuthenticated(false);
          onError(new Error(isAgentViewerIdentity(user.email ?? "")
            ? AGENT_VIEWER_LOGIN_ERROR
            : CENTRAL_VIEWER_LOGIN_ERROR));
          await signOut(services.auth);
        })
        .catch((error) => {
          if (!isCurrent()) return;
          onAuthenticated(false);
          onError(error instanceof Error ? error : new Error(CENTRAL_VIEWER_LOGIN_ERROR));
        });
    },
    (error) => onError(error),
  );
  return () => { active = false; unsubscribe(); };
}

export function subscribeViewerGrouping(uid: string, next: (grouping: ViewerGrouping) => void, failure: (error: Error) => void, env: ViewerFirebaseEnv = import.meta.env): Unsubscribe {
  const { auth, db } = getViewerFirebaseServices(env);
  if (auth.currentUser?.uid !== uid) { failure(new Error("Viewer login changed.")); return () => {}; }
  return onSnapshot(doc(db, "viewerGroupSettings", uid), { includeMetadataChanges: true }, snapshot => {
    if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) next(readViewerGrouping(snapshot.data()));
  }, failure);
}

export async function saveViewerGrouping(uid: string, change: (current: ViewerGrouping) => ViewerGrouping, env: ViewerFirebaseEnv = import.meta.env): Promise<void> {
  const { auth, db } = getViewerFirebaseServices(env);
  if (auth.currentUser?.uid !== uid) throw new Error("Viewer login changed.");
  const target = doc(db, "viewerGroupSettings", uid);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(target);
    if (auth.currentUser?.uid !== uid) throw new Error("Viewer login changed.");
    const current = readViewerGrouping(snapshot.data());
    const updated = readViewerGrouping(change(current));
    if (JSON.stringify(updated) !== JSON.stringify(current)) transaction.set(target, updated);
  }, { maxAttempts: 3 });
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
  discardOtherViewerPreparations();
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

export async function fetchFirebaseDevices(env: ViewerFirebaseEnv = import.meta.env, refreshPresence = false, signal?: AbortSignal, onProgress?: (devices: ManagedDevice[], pendingIds: string[]) => void, knownDevices: ManagedDevice[] = [], targetDeviceIds?: readonly string[]): Promise<ManagedDevice[]> {
  const services = getViewerFirebaseServices(env);
  requireCurrentUserId(services.auth.currentUser?.uid);
  if (signal?.aborted) return knownDevices;
  if (targetDeviceIds !== undefined) {
    const ids = new Set(targetDeviceIds);
    if (!ids.size) { onProgress?.([], []); return []; }
    const targets = knownDevices.filter(device => ids.has(device.id));
    const load = (async () => {
      const selectedIds = [...ids];
      const maxIdsPerQuery = 30;
      // Document reads can share the same SDK target as an ongoing manual heartbeat watch.
      const manualIds = new Set(refreshPresence ? targets.filter(device => device.presenceMode === "manual").map(device => device.id) : []);
      const groupedIds = selectedIds.filter(id => !manualIds.has(id));
      const directIds = groupedIds.length <= 1 ? selectedIds : selectedIds.filter(id => manualIds.has(id));
      const directReads = directIds.map(id => getDocFromServer(doc(services.db, "devices", id)).then(snapshot => [snapshot]));
      const groupReads = groupedIds.length <= 1 ? [] : Array.from({length:Math.ceil(groupedIds.length / maxIdsPerQuery)}, (_, index) => {
        const start = index * maxIdsPerQuery;
        return getDocsFromServer(query(collection(services.db, "devices"),
          where(documentId(), "in", groupedIds.slice(start, start + maxIdsPerQuery)))).then(snapshot => snapshot.docs);
      });
      const snapshots = (await Promise.all([...directReads,...groupReads])).flat();
      return prepareViewerDeviceList(snapshots.flatMap(snapshot => {
        const data = snapshot.data();
        return snapshot.exists() && data && !isDeletedDeviceDocument(data) ? [mapFirestoreDevice(snapshot.id, data)] : [];
      }), new Date().toISOString(), resolveViewerOfflineAfterMs(env));
    })();
    if (!refreshPresence) return load;
    const requestId = crypto.randomUUID();
    let watchDevice: (id: string) => boolean;
    return collectDevicePresence(targets, requestId, (next, fail) => {
      const stops: Unsubscribe[] = [];
      let active = true;
      watchDevice = id => {
        const stop = onSnapshot(doc(services.db, "devices", id), {includeMetadataChanges:true}, snapshot => {
          if (!active || !snapshot.exists() || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
          const data = snapshot.data();
          if (data.heartbeatRequestId === requestId && !isDeletedDeviceDocument(data)) next(mapFirestoreDevice(snapshot.id, data));
        }, fail);
        if (active) stops.push(stop);
        else stop();
        return active;
      };
      return () => { active = false; stops.forEach(stop => stop()); };
    }, async (device, action) => {
      // Reuse the selected document read's target and only watch devices we actually probe.
      if (watchDevice(device.id)) await enqueueFirebaseDeviceCommandDirect(device.id, action, env);
    }, signal, onProgress, load);
  }
  const inventory = collection(services.db, "devices");
  const load = getDocsFromServer(inventory).then((snapshot) => prepareViewerDeviceList(
    snapshot.docs
      .filter((deviceDoc) => !isDeletedDeviceDocument(deviceDoc.data()))
      .map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data())),
    new Date().toISOString(),
    resolveViewerOfflineAfterMs(env),
  ));
  if (!refreshPresence) return load;
  const parallel = knownDevices.some((device) => device.presenceMode === "manual");
  const devices = parallel ? knownDevices : await load;
  if (signal?.aborted) return devices;
  const requestId = crypto.randomUUID();
  return collectDevicePresence(devices, requestId, (next, fail) => {
    let serverCurrent = false;
    return onSnapshot(query(inventory, where("heartbeatRequestId", "==", requestId)), { includeMetadataChanges: true }, (updates) => {
      if (updates.metadata.fromCache) {
        serverCurrent = false;
        return;
      }
      // A cache-to-server transition may not include any document changes.
      const replies = serverCurrent
        ? updates.docChanges({ includeMetadataChanges: true }).flatMap(change => change.type === "removed" ? [] : [change.doc])
        : updates.docs;
      serverCurrent = true;
      for (const reply of replies) {
        if (reply.metadata.hasPendingWrites) continue;
        const data = reply.data();
        if (data.heartbeatRequestId === requestId && !isDeletedDeviceDocument(data)) next(mapFirestoreDevice(reply.id, data));
      }
    }, fail);
  }, (device, action) => enqueueFirebaseDeviceCommandDirect(device.id, action, env), signal, onProgress, parallel ? load : undefined);
}

export async function fetchFirebaseConnectionHistory(
  env: ViewerFirebaseEnv = import.meta.env,
  devices?: ManagedDevice[],
): Promise<ConnectionHistoryEntry[]> {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  const [sessionsSnapshot, knownDevices] = await Promise.all([
    getDocsFromServer(query(collection(services.db, "sessions"), where("ownerUid", "==", userId), limit(200))),
    devices ?? fetchFirebaseDevices(env),
  ]);
  return mapFirebaseSessionHistory(
    sessionsSnapshot.docs.map((sessionDoc) => ({
      id: sessionDoc.id,
      data: sessionDoc.data(),
    })),
    knownDevices,
  );
}

export function subscribeFirebaseConnectionHistory(
  onHistory: (history: ConnectionHistoryEntry[]) => void,
  onError: (error: Error) => void,
  getDevices: () => ManagedDevice[],
  env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  return onSnapshot(
    query(collection(services.db, "sessions"), where("ownerUid", "==", userId), limit(200)),
    (snapshot) => onHistory(mapFirebaseSessionHistory(
      snapshot.docs.map((sessionDoc) => ({ id: sessionDoc.id, data: sessionDoc.data() })),
      getDevices(),
    )),
    onError,
  );
}

export async function fetchFirebaseAgentDevice(config: AgentLocalConfig, env: ViewerFirebaseEnv = import.meta.env): Promise<ManagedDevice> {
  if (!config.registeredDeviceId?.trim() || !config.installId?.trim()) throw new Error("등록된 Agent 정보가 없습니다.");
  const services = getViewerFirebaseServices(env);
  const business = normalizeBusinessNumber(config.authBusinessNumber ?? config.businessNumber ?? "");
  const credential = await signInWithEmailAndPassword(services.auth, buildAgentAuthEmail(business), buildAgentAuthPassword(business, "1234"));
  const snapshot = await getDocFromServer(doc(services.db, "devices", config.registeredDeviceId));
  if (!snapshot.exists()) throw new Error("등록된 장비를 찾지 못했습니다.");
  const data = snapshot.data();
  if (data.ownerUid !== credential.user.uid || data.installId !== config.installId || data.deletedAt) throw new Error("이 Agent의 장비 정보만 수정할 수 있습니다.");
  return mapFirestoreDevice(snapshot.id, data);
}

export async function updateFirebaseAgentDevice(config: AgentLocalConfig, input: Pick<ManagedDevice, "businessNumber" | "storeName" | "deviceName">, env: ViewerFirebaseEnv = import.meta.env): Promise<ManagedDevice> {
  const metadata = normalizeAgentMetadataUpdate(input);
  await fetchFirebaseAgentDevice(config, env);
  return updateFirebaseDeviceMetadata(config.registeredDeviceId!, metadata, env);
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
  const businessNumber = typeof input.businessNumber === "string" ? normalizeBusinessNumber(input.businessNumber) : currentDevice.businessNumber;
  const businessNumberChanged = businessNumber !== currentDevice.businessNumber;
  if (businessNumberChanged) update.businessNumber = businessNumber;
  const zookNumber = input.zookNumber === undefined ? undefined : normalizeZookNumber(input.zookNumber);
  const zookChanged = zookNumber !== undefined && zookNumber !== (currentDevice.zookNumber ?? currentDevice.zookAppliedNumber ?? "");
  if (zookChanged) { update.zookNumber = zookNumber; update.zookError = deleteField(); }

  if (typeof input.storeName === "string" && input.storeName.trim()) {
    const storeName = normalizeStoreNameForDisplay(input.storeName, currentDevice.businessNumber);
    update.storeName = storeName;
    update.storeNameSource = storeName === DEFAULT_STORE_NAME ? "default" : "user";
  }
  if (typeof input.deviceName === "string" && input.deviceName.trim()) {
    update.deviceName = input.deviceName.trim();
  }
  if (typeof input.desktopName === "string") {
    update.desktopNameOverride = input.desktopName.trim().slice(0, 255) || deleteField();
  }
  if (typeof input.contactName === "string") {
    update.contactName = sanitizeDeviceOperationalMetadataText(
      input.contactName,
      DEVICE_CONTACT_NAME_MAX_LENGTH,
    ) ?? deleteField();
  }
  if (typeof input.contactPhone === "string") {
    update.contactPhone = sanitizeDeviceOperationalMetadataText(input.contactPhone, DEVICE_CONTACT_PHONE_MAX_LENGTH) ?? deleteField();
  }
  if (typeof input.installLocation === "string") {
    update.installLocation = sanitizeDeviceOperationalMetadataText(
      input.installLocation,
      DEVICE_INSTALL_LOCATION_MAX_LENGTH,
    ) ?? deleteField();
  }
  if (input.tags !== undefined) {
    update.tags = sanitizeDeviceTags(input.tags) ?? deleteField();
  }
  if (typeof input.notes === "string") {
    update.notes = sanitizeDeviceOperationalMetadataText(input.notes, DEVICE_NOTES_MAX_LENGTH) ?? deleteField();
  }

  if (businessNumberChanged || zookChanged) {
    const batch = writeBatch(services.db);
    safeBatchUpdate(batch, deviceRef, update);
    if (businessNumberChanged) safeBatchSet(batch, doc(collection(services.db, "devices", deviceId, "commands")), {
      action: "sync-business-number", createdAt: serverTimestamp(), state: "pending",
    });
    if (zookChanged && zookNumber) safeBatchSet(batch, doc(collection(services.db, "devices", deviceId, "commands")), {
      action: "configure-zook", createdAt: serverTimestamp(), state: "pending",
    });
    await batch.commit();
  } else await safeUpdateDoc(deviceRef, update);
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
    storeName: input.storeName, deviceName: input.deviceName, notes: input.notes,
    businessNumber: input.businessNumber,
    desktopName: input.desktopName,
    installId: input.installId,
    nowIso: new Date().toISOString(),
    ownerUid: credential.user.uid,
    protocolVersion: input.protocolVersion,
    platform: input.platform,
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

type VerifiedViewerTarget = { device: ManagedDevice; data: Record<string, unknown>; viewerUid: string };

export async function openFirebaseSession(
  deviceId: string,
  env: ViewerFirebaseEnv = import.meta.env,
  refreshPresence = false,
  password?: string,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  const reconnect = refreshPresence ? new AbortController() : undefined;
  const signal = reconnect?.signal;
  if (reconnect) openingViewerReconnects.set(reconnect, requireCurrentUserId(getViewerFirebaseServices(env).auth.currentUser?.uid));
  const verifyPresence = async (): Promise<VerifiedViewerTarget> => {
    const services = getViewerFirebaseServices(env);
    const viewerUid = requireCurrentUserId(services.auth.currentUser?.uid);
    const ref = doc(services.db, "devices", deviceId);
    const snapshot = await getDocFromServer(ref);
    requireActiveViewerReconnect(signal);
    if (services.auth.currentUser?.uid !== viewerUid) throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
    if (!snapshot.exists()) throw new Error("Firebase device not found.");
    const data = snapshot.data();
    const device = mapFirestoreDevice(snapshot.id, data);
    const nonce = crypto.randomUUID();
    let confirmed = { device, data, viewerUid };
    const refreshed = await collectDevicePresence([device], nonce, (next, fail) => onSnapshot(ref, {includeMetadataChanges:true},
      update => {
        if (!update.exists() || update.metadata?.fromCache || update.metadata?.hasPendingWrites) return;
        const currentData = update.data();
        const currentDevice = mapFirestoreDevice(update.id, currentData);
        if (currentDevice.heartbeatRequestId === nonce) confirmed = {device:currentDevice, data:currentData, viewerUid};
        next(currentDevice);
      }, fail),
      (target, action) => enqueueFirebaseDeviceCommandDirect(target.id, action, env), signal);
    if (refreshed[0]?.status !== "online") throw new Error("원격 PC가 응답하지 않습니다. 다시 시도하세요.");
    if (services.auth.currentUser?.uid !== viewerUid) throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
    return confirmed;
  };
  try {
    if (refreshPresence && typeof RTCPeerConnection === "function" &&
      (password !== undefined || resolveViewerFunctionMode(env) === "direct") && !shouldUseDynamicTurnCredentials(env)) {
      return await openFirebaseSessionDirect(deviceId, env, password, verifyPresence, signal);
    }
    const verified = refreshPresence ? await verifyPresence() : undefined;
    requireActiveViewerReconnect(signal);
    // Return an already-created session ID so a cancelled caller can close it.
    if (password !== undefined) return await openFirebaseSessionDirect(deviceId, env, password, verified, signal);
    return await callViewerFunctionWithFirestoreFallback<
      { deviceId: string },
      { session: RemoteSession; inputLog: string[] }
    >("openSession", { deviceId }, env, () => openFirebaseSessionDirect(deviceId, env, undefined, verified, signal));
  } catch (error) {
    requireActiveViewerReconnect(signal);
    throw error;
  } finally {
    if (reconnect) openingViewerReconnects.delete(reconnect);
  }
}

export async function requestFirebaseDeviceAccess(
  deviceId: string, operation: DeviceAccessOperation, credentials: DeviceAccessCredentials,
  sessionId = "", signal?: AbortSignal, env: ViewerFirebaseEnv = import.meta.env,
): Promise<{requestId: string; version: string}> {
  const {db, auth} = getViewerFirebaseServices(env);
  const ownerUid = requireCurrentUserId(auth.currentUser?.uid);
  const device = await getDocFromServer(doc(db, "devices", deviceId));
  return requestDeviceAccessWithFreshData(deviceId, operation, credentials, sessionId, signal, env, {ownerUid, data:device.data()});
}

async function requestDeviceAccessWithFreshData(
  deviceId: string, operation: DeviceAccessOperation, credentials: DeviceAccessCredentials,
  sessionId: string, signal: AbortSignal | undefined, env: ViewerFirebaseEnv,
  {data, ownerUid}: {data: Record<string, unknown> | undefined; ownerUid: string},
): Promise<{requestId: string; version: string}> {
  const {db, auth} = getViewerFirebaseServices(env);
  if (requireCurrentUserId(auth.currentUser?.uid) !== ownerUid) throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
  if (data?.accessLockUnavailable === true) throw new Error("원격 에이전트의 잠금 저장소를 사용할 수 없습니다. 에이전트 재시작 또는 설정 복구가 필요합니다.");
  if (typeof data?.accessPublicKey !== "string") throw new Error("이 장비의 에이전트를 최신 버전으로 업데이트해야 접속 잠금을 사용할 수 있습니다.");
  const id = crypto.randomUUID();
  const encrypted = await encryptDeviceAccessRequest({id, deviceId, ownerUid, operation, sessionId, lockVersion:typeof data.accessLockVersion === "string" ? data.accessLockVersion : ""}, data.accessPublicKey, credentials);
  if (requireCurrentUserId(auth.currentUser?.uid) !== ownerUid) throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
  if (signal?.aborted) throw new Error("접속 잠금 요청이 취소되었습니다.");
  const requestRef = doc(db, "deviceAccessRequests", id);
  const batch = writeBatch(db);
  safeBatchSet(batch, requestRef, {...encrypted, state:"pending", createdAt:serverTimestamp()});
  safeBatchSet(batch, doc(collection(db, "devices", deviceId, "commands")), {action:`device-access ${id}`, createdAt:serverTimestamp(), state:"pending"});
  const queued = batch.commit();
  if (operation === "connect") markConnectionTiming(deviceId, "access-request-queued");
  await queued;
  if (operation === "connect") markConnectionTiming(deviceId, "access-request-acknowledged");
  return new Promise((resolve, reject) => {
    let unsubscribe: Unsubscribe = () => undefined;
    let finished = false;
    const finish = (error?: Error, version?: string) => {
      if (finished) return;
      finished = true;
      unsubscribe(); clearTimeout(timeout); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve({requestId:id, version:version!});
    };
    const cancel = (message: string) => { void deleteDoc(requestRef).catch(() => undefined); finish(new Error(message)); };
    const abort = () => cancel("접속 잠금 요청이 취소되었습니다.");
    const timeout = setTimeout(() => cancel("원격 에이전트가 잠금 요청에 응답하지 않습니다."), DEVICE_ACCESS_TTL_MS);
    signal?.addEventListener("abort", abort, {once:true});
    try {
      unsubscribe = onSnapshot(requestRef, snapshot => {
        const response = snapshot.data();
        if (response?.state === "approved" && typeof response.approvedVersion === "string") finish(undefined, response.approvedVersion);
        if (response?.state === "denied") finish(new Error(typeof response.error === "string" ? response.error : "잠금 요청이 거부되었습니다."));
      }, error => finish(error));
      if (finished) unsubscribe();
    } catch (error) { finish(error instanceof Error ? error : new Error("잠금 응답을 확인하지 못했습니다.")); }
    if (signal?.aborted) abort();
  });
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
  input: { challengeId: string; code: string; deviceId: string; password?: string },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  if (input.password !== undefined) return connectFirebaseSecureSessionDirect(input, env);
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
  discardPreparedViewerPeer(sessionId);
  pendingViewerSignals.get(sessionId)?.cancel();
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

export function subscribeViewerSessionData(
  sessionId: string, onData: (data: SessionData) => void | Promise<void>, onError: (error: Error) => void,
  options: SessionDataOptions = {}, onReady?: () => void | Promise<void>, env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  return subscribeFirebaseSessionData(getViewerFirebaseServices(env).db, sessionId, "viewer", onData, onError, options, onReady);
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
    collisionPolicy?: import("../domain/fileCollisionPolicy").FileCollisionPolicy;
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
    collisionPolicy: input.collisionPolicy,
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
    ...(typeof data.cursorEmbedded === "boolean" ? {cursorEmbedded:data.cursorEmbedded} : {}),
  }), env);
  return frames.reduce(
    (merged, frame) => ({
      tiles: [...merged.tiles, ...frame.tiles],
      width: frame.width || merged.width,
      height: frame.height || merged.height,
      sequence: frame.sequence ?? merged.sequence,
      keyframe: frame.keyframe || merged.keyframe,
      ...(typeof frame.cursorEmbedded === "boolean" ? {cursorEmbedded:frame.cursorEmbedded} : {}),
    }),
    { tiles: [] as any[], width: 0, height: 0, sequence: undefined, keyframe: false } as RemoteTileFrame,
  );
}

export async function startFirebaseViewerWebRtcTransport(
  sessionId: string,
  handlers: {
    startInFastMode?: boolean;
    onFrame: (frame: RemoteTileFrame) => void;
    onFileChunk?: (chunk: WebRtcFileChunkMessage, isCurrent: () => boolean) => Promise<WebRtcFileAckMessage | null>;
    onFileStatus?: (status: WebRtcFileStatusMessage) => void;
    onReverseFileSupport?: (resumeSupported?: boolean) => void;
    onFileCollisionSupport?: () => void;
    onState?: (state: string) => void;
    onDiagnostic?: (message: string) => void;
    onError?: (error: Error) => void;
  },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ViewerWebRtcTransport> {
  const services = getViewerFirebaseServices(env);
  const signalingOwnerUid = requireCurrentUserId(services.auth.currentUser?.uid);
  if (pendingViewerSignals.has(sessionId)) throw new Error("WebRTC setup is already in progress.");
  const pending = preparedViewerPeers.get(sessionId);
  let prepared: PreparedViewerPeer | null = null;
  let rtcConfiguration: Awaited<ReturnType<typeof loadViewerRtcConfiguration>> | null = null;
  if (pending) {
    if (pending.claimed) throw new Error("WebRTC setup is already in progress.");
    pending.claimed = true;
    clearTimeout(pending.timer);
    const configurationDeadline = performance.now() + VIEWER_RTC_CONFIGURATION_BUDGET_MS;
    const ensureCurrent = () => {
      if (preparedViewerPeers.get(sessionId) !== pending || pending.ownerUid !== services.auth.currentUser?.uid) {
        throw new Error("WebRTC setup was cancelled or the Viewer account changed.");
      }
    };
    let handoffTimer: ReturnType<typeof setTimeout> | undefined;
    let configurationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      ensureCurrent();
      prepared = await Promise.race([pending.ready, pending.cancelled, new Promise<null>(resolve => {
        handoffTimer = setTimeout(() => resolve(null), VIEWER_PEER_HANDOFF_MS);
      })]);
      clearTimeout(handoffTimer);
      ensureCurrent();
      if (!prepared) {
        pending.abandonOffer();
        const expireConfiguration = new Promise<null>(resolve => {
          configurationTimer = setTimeout(() => resolve(null), Math.max(0, configurationDeadline - performance.now()));
        });
        try {
          rtcConfiguration = await Promise.race([pending.configuration, pending.cancelled, expireConfiguration]);
        } catch {
          ensureCurrent();
          const remaining = Math.ceil(configurationDeadline - performance.now());
          if (remaining > 0) {
            rtcConfiguration = await Promise.race([loadViewerRtcConfiguration(env, remaining), pending.cancelled, expireConfiguration]);
          }
        }
        ensureCurrent();
        if (!rtcConfiguration) throw new Error("WebRTC configuration timed out.");
      }
      preparedViewerPeers.delete(sessionId);
    } catch (error) {
      discardPreparedViewerPeer(sessionId);
      throw error;
    } finally {
      clearTimeout(handoffTimer);
      clearTimeout(configurationTimer);
    }
  } else {
    rtcConfiguration = await loadViewerRtcConfiguration(env);
    if (services.auth.currentUser?.uid !== signalingOwnerUid) throw new Error("WebRTC Viewer account changed.");
  }
  if (pendingViewerSignals.has(sessionId)) {
    prepared?.peer.close();
    throw new Error("WebRTC setup is already in progress.");
  }
  const peer = prepared?.peer ?? new RTCPeerConnection({iceServers:rtcConfiguration!.iceServers,iceTransportPolicy:rtcConfiguration!.iceTransportPolicy});
  const signalRef = doc(services.db, "sessions", sessionId, "webrtc", "signal");
  const viewerCandidates = collection(services.db, "sessions", sessionId, "viewerCandidates");
  const agentCandidates = collection(services.db, "sessions", sessionId, "agentCandidates");
  const recentAgentCandidates = query(
    agentCandidates,
    orderBy("createdAt", "desc"),
    limit(MAX_RECENT_WEBRTC_CANDIDATES),
  );
  const appliedCandidateIds = new Set<string>();
  const applyingCandidateIds = new Set<string>();
  const automaticallyRetriedCandidateIds = new Set<string>();
  const pendingAgentCandidates = new Map<string, RTCIceCandidateInit>();
  const pendingLocalCandidates = prepared?.candidates ?? [];
  const negotiationId = prepared?.negotiationId ?? createFirebaseSessionId("rtc");
  let offerQueued = false;
  let includesCandidate = prepared?.offerWrite?.includesCandidate;
  let answerApplied = false;
  let answerApplyInFlight = false;
  let channelOpened = false;
  let controlChannelOpened = false;
  let initialKeyframeRequested = false;
  let fileChannelOpened = false;
  let closedByCaller = false;
  let resourcesClosed = false;
  let unsubscribeSignal: Unsubscribe | null = null;
  let unsubscribeAgentCandidates: Unsubscribe | null = null;
  let candidateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  let pendingControlActions: string[] = [];
  let pendingPointerMove: string | null = null;
  const frameAssembler = new WebRtcFrameAssembler();
  const fileAckStates = new Map<string, WebRtcFileAckMessage>();
  let incomingFileQueue = Promise.resolve();
  let pendingIncomingFiles = 0;
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

  const signalAttempt = {ownerUid:signalingOwnerUid, cancel: () => { closedByCaller = true; closeResources(); }};
  const clearSignalAttempt = () => {
    if (pendingViewerSignals.get(sessionId) === signalAttempt) pendingViewerSignals.delete(sessionId);
  };
  const closeResources = (): void => {
    if (resourcesClosed) {
      return;
    }
    resourcesClosed = true;
    clearSignalAttempt();
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
    pendingPointerMove = null;
    pendingAgentCandidates.clear();
    pendingLocalCandidates.length = 0;
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

  const canPublishSignal = () => {
    if (resourcesClosed || closedByCaller) return false;
    if (services.auth.currentUser?.uid === signalingOwnerUid) return true;
    reportUnavailable("viewer-account-changed");
    return false;
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

  const channel = prepared?.channels[0] ?? peer.createDataChannel(WEBRTC_TILE_CHANNEL_LABEL, viewerTileDataChannelOptions());
  const controlChannel = prepared?.channels[1] ?? peer.createDataChannel(WEBRTC_CONTROL_CHANNEL_LABEL, { ordered: true });
  const sendControlPayload = (payload: string) => {
    try {
      controlChannel.send(payload);
      return true;
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };
  // Motion is replaceable, so do not queue it behind other buffered control data.
  controlChannel.bufferedAmountLowThreshold = 0;
  controlChannel.onbufferedamountlow = () => {
    if (closedByCaller || resourcesClosed || !controlChannelOpened || controlChannel.readyState !== "open"
      || controlChannel.bufferedAmount > 0 || pendingPointerMove === null) return;
    const payload = pendingPointerMove;
    pendingPointerMove = null;
    sendControlPayload(payload);
  };
  const fileChannel = prepared?.channels[2] ?? peer.createDataChannel(WEBRTC_FILE_CHANNEL_LABEL, { ordered: true });
  const markConnectionReady = () => {
    if (!channelOpened || !controlChannelOpened || initialKeyframeRequested) {
      return;
    }
    initialKeyframeRequested = true;
    clearConnectWatchdog();
    try {
      if (handlers.startInFastMode) controlChannel.send(serializeWebRtcControlAction(buildSetStreamModeCommand("fast")));
      controlChannel.send(serializeWebRtcControlAction("request-keyframe"));
    } catch (error) {
      reportUnavailable("control-channel-send-failed", error instanceof Error ? error.message : String(error));
      return;
    }
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
    if (!closedByCaller && !resourcesClosed) handlers.onState?.("webrtc-file-closed");
    reportDiagnostic("file-channel-error", error.message);
  };
  fileChannel.onmessage = (event) => {
    if (closedByCaller || resourcesClosed || !fileChannelOpened) return;
    if (isReverseFileCapability(event.data)) {
      handlers.onReverseFileSupport?.(supportsReverseFileResume(event.data));
      if (supportsFileCollisionPolicy(event.data)) handlers.onFileCollisionSupport?.();
      return;
    }
    const fileStatus = parseWebRtcFileStatus(event.data);
    if (fileStatus) { handlers.onFileStatus?.(fileStatus); return; }
    const chunk = parseWebRtcFileChunk(event.data);
    if (chunk) {
      if (pendingIncomingFiles >= 16) {
        fileChannelOpened = false;
        fileChannel.close();
        rejectAllFileWaiters(new Error("Incoming file queue limit exceeded."));
        reportDiagnostic("file-channel-error", "Incoming file queue limit exceeded.");
        return;
      }
      pendingIncomingFiles += 1;
      incomingFileQueue = incomingFileQueue.then(async () => {
        const isCurrent = () => !closedByCaller && !resourcesClosed && fileChannelOpened && fileChannel.readyState === "open";
        if (!isCurrent()) return;
        let result: WebRtcFileAckMessage | null;
        try {
          if (!handlers.onFileChunk) throw new Error("File receiver unavailable.");
          result = await handlers.onFileChunk(chunk, isCurrent);
          if (result && (result.transferId !== chunk.transferId ||
            result.receivedChunks > chunk.totalChunks || result.receivedBytes > chunk.totalBytes ||
            (result.status === "complete" && (result.receivedChunks !== chunk.totalChunks || result.receivedBytes !== chunk.totalBytes)))) {
            throw new Error("Invalid file receipt.");
          }
        } catch {
          result = { type: "file-ack", transferId: chunk.transferId, status: "error", receivedBytes: 0, receivedChunks: 0,
            error: "Viewer could not save the file." };
        }
        if (result && isCurrent()) fileChannel.send(serializeWebRtcFileAck(result));
      }).catch(() => {
        if (!closedByCaller && !resourcesClosed) reportDiagnostic("file-channel-error", "Viewer file acknowledgement failed.");
      }).finally(() => { pendingIncomingFiles -= 1; });
      return;
    }
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
  pendingViewerSignals.set(sessionId, signalAttempt);
  const sendLocalCandidate = (candidate: RTCIceCandidate) => {
    if (!canPublishSignal()) return;
    if (!offerQueued) {
      pendingLocalCandidates.push(candidate);
      return;
    }
    const data = candidate.toJSON();
    if (includesCandidate?.(data)) return;
    void safeAddDoc(viewerCandidates, {
      candidate: data,
      createdAt: serverTimestamp(),
      negotiationId,
    }).catch((error) => reportDiagnostic(
      "viewer-candidate-write-failed",
      error instanceof Error ? error.message : String(error),
    ));
  };
  peer.onicecandidate = event => { if (event.candidate) sendLocalCandidate(event.candidate); };

  const watchSignal = () => onSnapshot(
    signalRef,
    (snapshot) => {
      if (!canPublishSignal()) return;
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

  const watchAgentCandidates = () => onSnapshot(
    recentAgentCandidates,
    (snapshot) => {
      if (!canPublishSignal()) return;
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
    const offer = prepared?.offer ?? await peer.createOffer();
    if (!canPublishSignal()) return;
    if (!prepared) await peer.setLocalDescription(offer);
    if (!canPublishSignal()) return;
    const earlyWrite = prepared?.offerWrite;
    if (earlyWrite?.failure) throw earlyWrite.failure.error;
    const offerWrite = earlyWrite ?? queueViewerOffer(signalRef, sessionId, negotiationId, peer.localDescription ?? offer);
    includesCandidate = offerWrite.includesCandidate;
    // Watches get the current snapshot, so they need not run ahead of the offer or wait for its ACK.
    const watchAndFlush = async () => {
      if (!canPublishSignal()) return;
      let watchFailure = "signal-listener-failed";
      try {
        const stopSignal = watchSignal();
        if (!canPublishSignal()) { stopSignal(); return; }
        unsubscribeSignal = stopSignal;
        watchFailure = "agent-candidate-listener-failed";
        const stopCandidates = watchAgentCandidates();
        if (!canPublishSignal()) { stopCandidates(); return; }
        unsubscribeAgentCandidates = stopCandidates;
      } catch (error) {
        reportUnavailable(watchFailure, error instanceof Error ? error.message : String(error));
        return;
      }
      offerQueued = true;
      for (const candidate of pendingLocalCandidates.splice(0)) sendLocalCandidate(candidate);
    };
    await Promise.all([offerWrite.result, watchAndFlush()]);
    if (!canPublishSignal()) {
      return;
    }
    handlers.onState?.("webrtc-offer-sent");
  })().catch((error) => {
    reportUnavailable("offer-failed", error instanceof Error ? error.message : String(error));
  }).finally(clearSignalAttempt);

  const waitForFileAck = (transferId: string, minReceivedChunks: number, signal?: AbortSignal): Promise<WebRtcFileAckMessage> => {
    if (signal?.aborted) return Promise.reject(new DOMException("File transfer cancelled.", "AbortError"));
    const current = fileAckStates.get(transferId);
    if (current?.status === "error") {
      return Promise.reject(new Error(current.error || "Agent rejected the WebRTC file transfer."));
    }
    if (current && current.receivedChunks >= minReceivedChunks) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      const waiters = fileAckWaiters.get(transferId) ?? new Set();
      const cleanup = () => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", abort);
        waiters.delete(waiter);
        if (waiters.size === 0) fileAckWaiters.delete(transferId);
      };
      const abort = () => waiter.reject(new DOMException("File transfer cancelled.", "AbortError"));
      const waiter = {
        minReceivedChunks,
        resolve: (ack: WebRtcFileAckMessage) => { cleanup(); resolve(ack); },
        reject: (error: Error) => { cleanup(); reject(error); },
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            fileAckWaiters.delete(transferId);
          }
          waiter.reject(new Error(`WebRTC file acknowledgement timed out at chunk ${minReceivedChunks}.`));
        }, WEBRTC_FILE_ACK_TIMEOUT_MS),
      };
      waiters.add(waiter);
      fileAckWaiters.set(transferId, waiters);
      signal?.addEventListener("abort", abort, {once:true});
      if (signal?.aborted) abort();
    });
  };

  const sendFile = async (input: {
    collisionPolicy?: import("../domain/fileCollisionPolicy").FileCollisionPolicy;
    resume?: boolean;
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
        const chunkSha256 = await sha256ArrayBufferHex(chunkBuffer);
        if (input.signal?.aborted) throw new DOMException("File transfer cancelled.", "AbortError");
        fileChannel.send(serializeWebRtcFileChunk({
          type: "file-chunk",
          transferId: input.transferId,
          filename: input.filename,
          ...(input.collisionPolicy ? { collisionPolicy: input.collisionPolicy } : {}),
          chunkIndex,
          totalChunks,
          totalBytes: input.file.size,
          isLast: chunkIndex === totalChunks - 1,
          fileData: arrayBufferToBase64(chunkBuffer),
          chunkSha256,
          ...(chunkIndex === totalChunks - 1 ? { fileSha256: input.fileSha256 } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        }));

        const sentChunks = chunkIndex + 1;
        if (input.resume && chunkIndex === 0 && totalChunks > 1) {
          const ack = await waitForFileAck(input.transferId, 1, input.signal);
          if (input.signal?.aborted) throw new DOMException("File transfer cancelled.", "AbortError");
          if (ack.receivedChunks > totalChunks || ack.receivedBytes !== Math.min(input.file.size, ack.receivedChunks * WEBRTC_FILE_CHUNK_BYTES)) {
            throw new Error("Invalid file resume acknowledgement.");
          }
          if (ack.status === "complete") {
            if (ack.receivedChunks !== totalChunks) throw new Error("Invalid file completion acknowledgement.");
            input.onProgress?.(input.file.size, input.file.size);
            return true;
          }
          if (ack.receivedChunks === totalChunks) throw new Error("Agent has not confirmed file completion.");
          input.onProgress?.(ack.receivedBytes,input.file.size);
          chunkIndex = ack.receivedChunks - 1;
          continue;
        }
        if (sentChunks % WEBRTC_FILE_WINDOW_CHUNKS === 0 || sentChunks === totalChunks) {
          const ack = await waitForFileAck(input.transferId, sentChunks, input.signal);
          if (input.signal?.aborted) {
            throw new DOMException("File transfer cancelled.", "AbortError");
          }
          if (ack.status === "complete" &&
            (ack.receivedChunks !== totalChunks || ack.receivedBytes !== input.file.size)) {
            throw new Error("Invalid file completion acknowledgement.");
          }
          if (sentChunks === totalChunks && ack.status !== "complete") {
            throw new Error("Agent did not confirm the completed WebRTC file transfer.");
          }
          input.onProgress?.(ack.receivedBytes, input.file.size);
        }
      }
      return true;
    } finally {
      fileAckStates.delete(input.transferId);
    }
  };

  return {
    close: signalAttempt.cancel,
    isControlReady: () =>
      !resourcesClosed &&
      !closedByCaller &&
      controlChannelOpened &&
      controlChannel.readyState === "open",
    cancelPointerMove: () => { pendingPointerMove = null; },
    sendControl: (action) => {
      if (resourcesClosed || closedByCaller) {
        return false;
      }
      const payload = serializeWebRtcControlAction(action);
      const isMove = action.startsWith("move ");
      const previousMove = pendingPointerMove;
      pendingPointerMove = null;
      if (!controlChannelOpened || controlChannel.readyState !== "open") {
        if (isMove) return false;
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
      if (isMove && controlChannel.bufferedAmount > 0) {
        pendingPointerMove = payload;
        return true;
      }
      if (previousMove !== null && /^(?:key-|keypress |text-base64 |text-replace-base64 )/.test(action)) {
        try { controlChannel.send(previousMove); }
        catch {
          // A replaceable move must not close the channel before the key or text is sent.
        }
      }
      return sendControlPayload(payload);
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
  password?: string,
  target?: VerifiedViewerTarget | (() => Promise<VerifiedViewerTarget>),
  reconnectSignal?: AbortSignal,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  requireActiveViewerReconnect(reconnectSignal);
  const services = getViewerFirebaseServices(env);
  const userId = requireCurrentUserId(services.auth.currentUser?.uid);
  // Prepare only local RTC state; no signaling/control/capture precedes authorization.
  let allowGathering: (() => void) | undefined;
  const preparation = typeof RTCPeerConnection === "function" ? beginViewerPeerPreparation(env, userId,
    typeof target === "function" ? new Promise<void>(resolve => { allowGathering = resolve; }) : undefined) : null;
  if (preparation) openingViewerPeers.add(preparation);
  const requireSessionOwner = () => {
    requireActiveViewerReconnect(reconnectSignal);
    if (services.auth.currentUser?.uid !== userId || (preparation && !openingViewerPeers.has(preparation))) {
      throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
    }
  };
  try {
    const verified = typeof target === "function" ? await target() : target;
    if (verified && verified.viewerUid !== userId) throw new Error("로그인 계정이 변경되었습니다. 다시 시도하세요.");
    const {device, data} = verified ? requireCompatibleDevice(verified.device, verified.data)
      : await requireFirebaseOnlineCompatibleDeviceDirect(deviceId, env);
    markConnectionTiming(deviceId, "device-validated");
    const session = buildConnectedSession(deviceId);
    let access: {accessRequestId: string; accessLockVersion: string} | undefined;
    if (device.accessLocked) {
      requireSessionOwner();
      if (password === undefined) throw new Error("잠금 비밀번호를 입력해야 이 장비에 접속할 수 있습니다.");
      const authorization = await requestDeviceAccessWithFreshData(deviceId, "connect", {password}, session.id, reconnectSignal, env, {ownerUid:userId, data});
      markConnectionTiming(deviceId, "access-approved");
      access = {accessRequestId:authorization.requestId, accessLockVersion:authorization.version};
    }
    requireSessionOwner();
    allowGathering?.();
    const batch = writeBatch(services.db);
    safeBatchSet(batch, doc(services.db, "sessions", session.id), {
      ...access,
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
    if (preparation && openingViewerPeers.has(preparation) && services.auth.currentUser?.uid === userId) {
      if (preparedViewerPeers.size >= MAX_PREPARED_VIEWER_PEERS) {
        const available = [...preparedViewerPeers].find(([, pending]) => !pending.claimed);
        if (available) discardPreparedViewerPeer(available[0]);
      }
      if (preparedViewerPeers.size < MAX_PREPARED_VIEWER_PEERS) {
        const timer = setTimeout(() => discardPreparedViewerPeer(session.id), resolveWebRtcConnectTimeoutMs(env));
        preparedViewerPeers.set(session.id, {...preparation, services, claimed:false, timer});
      } else preparation.cancel();
    } else {
      preparation?.cancel();
    }
    markConnectionTiming(deviceId, "command-dispatched");
    return {
      inputLog: [`${new Date().toLocaleTimeString()} start-stream queued via Firestore fallback`],
      session,
    };
  } catch (error) {
    preparation?.cancel();
    throw error;
  } finally {
    if (preparation) openingViewerPeers.delete(preparation);
  }
}

async function requireFirebaseOnlineCompatibleDeviceDirect(
  deviceId: string,
  env: ViewerFirebaseEnv,
): Promise<{device: ManagedDevice; data: Record<string, unknown>}> {
  const services = getViewerFirebaseServices(env);
  const deviceSnapshot = await getDocFromServer(doc(services.db, "devices", deviceId));
  if (!deviceSnapshot.exists()) {
    throw new Error("Firebase device not found.");
  }
  const data = deviceSnapshot.data();
  return requireCompatibleDevice(mapFirestoreDevice(deviceSnapshot.id, data), data);
}

function requireCompatibleDevice(device: ManagedDevice, data: Record<string, unknown>) {
  if (device.status !== "online") {
    throw new Error("Only online agents can accept connections.");
  }
  const protocolDecision = evaluateRemoteProtocolCompatibility(device.protocolVersion);
  if (!protocolDecision.compatible) {
    throw new Error(remoteProtocolErrorMessage(protocolDecision));
  }
  return {device, data};
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
  input: { challengeId: string; code: string; deviceId: string; password?: string },
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
  return openFirebaseSessionDirect(input.deviceId, env, input.password);
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

export async function requestFirebaseAgentUpdate(deviceId: string, requestId = String(Date.now())): Promise<void> {
  if (!/^\d{13}$/.test(requestId)) throw new Error("Invalid update request ID");
  await enqueueFirebaseDeviceCommandDirect(deviceId, `request-update ${requestId}`, import.meta.env);
}

export function subscribeFirebaseAgentUpdate(deviceId: string, next: (device: ManagedDevice) => void, fail: (error: Error) => void): Unsubscribe {
  const services=getViewerFirebaseServices(import.meta.env);
  requireCurrentUserId(services.auth.currentUser?.uid);
  return onSnapshot(doc(services.db,"devices",deviceId), snapshot=>{
    if(snapshot.metadata?.fromCache)return;
    if(!snapshot.exists()||isDeletedDeviceDocument(snapshot.data())) {fail(new Error("장비가 삭제되었거나 등록되어 있지 않습니다."));return;}
    next(mapFirestoreDevice(snapshot.id,snapshot.data()));
  },fail);
}

export async function requestFirebaseAgentRollback(deviceId: string, version: string, env: ViewerFirebaseEnv = import.meta.env): Promise<void> {
  const services = getViewerFirebaseServices(env);
  const user = services.auth.currentUser;
  if (!user || !await isAuthorizedViewerUser(user)) throw new Error("Only the central Viewer can request rollback.");
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)) throw new Error("Invalid rollback version.");
  const deviceRef = doc(services.db, "devices", deviceId);
  const snapshot = await getDocFromServer(deviceRef);
  const device = snapshot.exists() ? snapshot.data() : null;
  if (!device || device.deletedAt || device.platform === "android" || typeof device.version !== "string"
      || device.rollbackSupportVersion !== device.version || !isHigherVersion(device.version, version)) {
    throw new Error("This Agent has not confirmed support for the requested rollback.");
  }
  const batch = writeBatch(services.db);
  safeBatchUpdate(batch, deviceRef, { updatePaused: true, updatedAt: serverTimestamp() });
  safeBatchSet(batch, doc(collection(services.db, "devices", deviceId, "commands")), {
    action: `request-rollback ${version} ${Date.now()}`, createdAt: serverTimestamp(), state: "pending",
  });
  await batch.commit();
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
