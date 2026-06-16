import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import type {
  AgentFirstRunInput,
  AgentFirstRunResult,
  ChatMessage,
  ClipboardData,
  DeviceMetadataUpdateInput,
  FileTransferReceipt,
  ManagedDevice,
  RemoteSession,
  TransferredFile,
} from "../domain/types";
import { sortDevices } from "../domain/agentRegistry";
import { resolveRtcIceServers, shouldUseRelayOnly } from "../domain/rtcTransport";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { buildAgentAuthEmail, buildAgentAuthPassword } from "./firebaseIdentity";
import { buildFirestoreDevice, mapFirestoreDevice } from "./firestoreDevice";
import { getWonRemoteFirebaseServices } from "./firebaseServices";
import { throwExplainedFirebaseAuthError } from "./firebaseError";

type ViewerFirebaseEnv = ImportMetaEnv;

export interface ViewerWebRtcTransport {
  close: () => void;
}

export function isViewerFirebaseEnabled(env: ViewerFirebaseEnv = import.meta.env): boolean {
  return resolveFirebaseConfig(env) !== null;
}

export async function loginViewerWithFirebase(
  username: string,
  password: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  try {
    await setPersistence(services.auth, browserLocalPersistence);
    await signInWithEmailAndPassword(services.auth, username.trim(), password);
  } catch (error) {
    throwExplainedFirebaseAuthError(error);
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
    (user) => onAuthenticated(Boolean(user)),
    (error) => onError(error),
  );
}

export async function logoutViewerWithFirebase(env: ViewerFirebaseEnv = import.meta.env): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await signOut(services.auth);
}

export function subscribeFirebaseDevices(
  onDevices: (devices: ManagedDevice[]) => void,
  onError: (error: Error) => void,
  env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  const services = getViewerFirebaseServices(env);
  const devicesCollection = collection(services.db, "devices");

  return onSnapshot(
    devicesCollection,
    (snapshot) => {
      onDevices(sortDevices(snapshot.docs.map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data()))));
    },
    (error) => onError(error),
  );
}

export async function fetchFirebaseDevices(env: ViewerFirebaseEnv = import.meta.env): Promise<ManagedDevice[]> {
  const services = getViewerFirebaseServices(env);
  const snapshot = await getDocs(collection(services.db, "devices"));
  return sortDevices(snapshot.docs.map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data())));
}

export async function updateFirebaseDeviceMetadata(
  deviceId: string,
  input: Omit<DeviceMetadataUpdateInput, "deviceId">,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ManagedDevice> {
  const services = getViewerFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", deviceId);
  const update: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (typeof input.storeName === "string" && input.storeName.trim()) {
    update.storeName = input.storeName.trim();
    update.storeNameSource = "user";
  }
  if (typeof input.deviceName === "string" && input.deviceName.trim()) {
    update.deviceName = input.deviceName.trim();
  }
  if (typeof input.desktopName === "string" && input.desktopName.trim()) {
    update.desktopName = input.desktopName.trim();
  }

  await updateDoc(deviceRef, update);
  const snapshot = await getDoc(deviceRef);
  if (!snapshot.exists()) {
    throw new Error("Firebase device not found.");
  }
  return mapFirestoreDevice(snapshot.id, snapshot.data());
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
    installId: input.installId,
    nowIso: new Date().toISOString(),
    ownerUid: credential.user.uid,
    version: input.version,
  });

  await setDoc(
    doc(services.db, "devices", device.id),
    {
      ...device,
      installId: input.installId,
      ownerUid: credential.user.uid,
    },
    { merge: true },
  );

  return {
    devices: [device],
    device,
  };
}

export async function openFirebaseSession(
  deviceId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<{ session: RemoteSession; inputLog: string[] }> {
  const services = getViewerFirebaseServices(env);
  const startedAt = new Date().toISOString();
  const session: RemoteSession = {
    id: firebaseSessionIdForDevice(deviceId),
    deviceId,
    state: "connected",
    startedAt,
  };

  await setDoc(
    doc(services.db, "sessions", session.id),
    {
      ...session,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  await enqueueFirebaseAgentCommand(deviceId, "start-stream", env);

  return {
    session,
    inputLog: [`${new Date().toLocaleTimeString()} start-stream queued via Firebase`],
  };
}

export async function recordFirebaseInput(
  sessionId: string,
  action: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<string[]> {
  const deviceId = deviceIdFromFirebaseSessionId(sessionId);
  await enqueueFirebaseAgentCommand(deviceId, action, env);
  return [`${new Date().toLocaleTimeString()} ${action}`];
}

export async function closeFirebaseSession(
  sessionId: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  const deviceId = deviceIdFromFirebaseSessionId(sessionId);
  await enqueueFirebaseAgentCommand(deviceId, "stop-stream", env);
  await updateDoc(doc(services.db, "sessions", sessionId), {
    closedAt: serverTimestamp(),
    state: "closed",
    updatedAt: serverTimestamp(),
  }).catch(() => undefined);
}

export async function sendFirebaseChatMessage(
  sessionId: string,
  message: string,
  sender: "viewer" | "agent",
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await addDoc(collection(services.db, "sessions", sessionId, "chat"), {
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
  await addDoc(collection(services.db, "sessions", sessionId, "clipboard"), {
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
  await addDoc(collection(services.db, "sessions", sessionId, "files"), {
    ...input,
    sender: "viewer",
    target: "agent",
    createdAt: serverTimestamp(),
  });
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
): Promise<{ tiles: any[]; width: number; height: number }> {
  const frames = await drainFirebaseSessionQueue(sessionId, "tileFrames", 3, undefined, (_id, data) => ({
    tiles: Array.isArray(data.tiles) ? data.tiles : [],
    width: Number(data.width ?? 0),
    height: Number(data.height ?? 0),
  }), env);
  return frames.reduce(
    (merged, frame) => ({
      tiles: [...merged.tiles, ...frame.tiles],
      width: frame.width || merged.width,
      height: frame.height || merged.height,
    }),
    { tiles: [] as any[], width: 0, height: 0 },
  );
}

export async function startFirebaseViewerWebRtcTransport(
  sessionId: string,
  handlers: {
    onFrame: (frame: { tiles: any[]; width: number; height: number }) => void;
    onState?: (state: string) => void;
    onError?: (error: Error) => void;
  },
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<ViewerWebRtcTransport> {
  const services = getViewerFirebaseServices(env);
  const peer = new RTCPeerConnection({
    iceServers: resolveRtcIceServers(env),
    iceTransportPolicy: shouldUseRelayOnly(env) ? "relay" : "all",
  });
  const signalRef = doc(services.db, "sessions", sessionId, "webrtc", "signal");
  const viewerCandidates = collection(services.db, "sessions", sessionId, "viewerCandidates");
  const agentCandidates = collection(services.db, "sessions", sessionId, "agentCandidates");
  const appliedCandidateIds = new Set<string>();
  let answerApplied = false;

  const channel = peer.createDataChannel("wonremote-tiles", {
    ordered: false,
    maxRetransmits: 0,
  });
  channel.onopen = () => handlers.onState?.("webrtc-open");
  channel.onclose = () => handlers.onState?.("webrtc-closed");
  channel.onerror = () => handlers.onError?.(new Error("Viewer WebRTC data channel failed."));
  channel.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as { tiles?: unknown; width?: unknown; height?: unknown };
      if (Array.isArray(frame.tiles)) {
        handlers.onFrame({
          tiles: frame.tiles,
          width: Number(frame.width ?? 0),
          height: Number(frame.height ?? 0),
        });
      }
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  peer.onconnectionstatechange = () => handlers.onState?.(`webrtc-${peer.connectionState}`);
  peer.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    void addDoc(viewerCandidates, {
      candidate: event.candidate.toJSON(),
      createdAt: serverTimestamp(),
    }).catch((error) => handlers.onError?.(error instanceof Error ? error : new Error(String(error))));
  };

  const unsubscribeSignal = onSnapshot(
    signalRef,
    (snapshot) => {
      const answer = snapshot.data()?.answer as { type?: unknown; sdp?: unknown } | undefined;
      if (answerApplied || answer?.type !== "answer" || typeof answer.sdp !== "string") {
        return;
      }
      answerApplied = true;
      void peer
        .setRemoteDescription({ type: "answer", sdp: answer.sdp })
        .catch((error) => handlers.onError?.(error instanceof Error ? error : new Error(String(error))));
    },
    (error) => handlers.onError?.(error),
  );

  const unsubscribeAgentCandidates = onSnapshot(
    agentCandidates,
    (snapshot) => {
      snapshot.docs.forEach((candidateDoc) => {
        if (appliedCandidateIds.has(candidateDoc.id)) {
          return;
        }
        appliedCandidateIds.add(candidateDoc.id);
        const candidate = candidateDoc.data().candidate;
        if (candidate) {
          void peer
            .addIceCandidate(candidate as RTCIceCandidateInit)
            .catch((error) => handlers.onError?.(error instanceof Error ? error : new Error(String(error))));
        }
      });
    },
    (error) => handlers.onError?.(error),
  );

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await setDoc(
    signalRef,
    {
      offer: {
        type: offer.type,
        sdp: offer.sdp,
      },
      state: "viewer-offer",
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  handlers.onState?.("webrtc-offer-sent");

  return {
    close: () => {
      unsubscribeSignal();
      unsubscribeAgentCandidates();
      channel.close();
      peer.close();
    },
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

export async function enqueueFirebaseAgentCommand(
  deviceId: string,
  action: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await addDoc(collection(services.db, "devices", deviceId, "commands"), {
    action,
    createdAt: serverTimestamp(),
    state: "pending",
  });
}

function getViewerFirebaseServices(env: ViewerFirebaseEnv) {
  const config = resolveFirebaseConfig(env);
  if (!config) {
    throw new Error("Firebase 설정이 없습니다. VITE_WONREMOTE_FIREBASE_* 값을 설정해야 합니다.");
  }
  return getWonRemoteFirebaseServices(config);
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

function firebaseSessionIdForDevice(deviceId: string): string {
  return `session-${deviceId}`;
}

function deviceIdFromFirebaseSessionId(sessionId: string): string {
  if (!sessionId.startsWith("session-")) {
    throw new Error("Invalid Firebase session id.");
  }
  return sessionId.slice("session-".length);
}
