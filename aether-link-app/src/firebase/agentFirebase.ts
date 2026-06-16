import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import type {
  AgentCommand,
  AgentCommandPollResult,
  AgentFirstRunInput,
  AgentFirstRunResult,
  AgentHeartbeatInput,
  AgentHeartbeatResult,
  ChatMessage,
  ClipboardData,
  FileTransferReceipt,
  TransferredFile,
} from "../domain/types";
import { resolveRtcIceServers, shouldUseRelayOnly } from "../domain/rtcTransport";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { buildAgentAuthEmail, buildAgentAuthPassword } from "./firebaseIdentity";
import { buildFirestoreDevice, mapFirestoreDevice } from "./firestoreDevice";
import { getWonRemoteFirebaseServices } from "./firebaseServices";
import { throwExplainedFirebaseAuthError } from "./firebaseError";

type AgentFirebaseEnv = Record<string, string | undefined>;

export interface AgentWebRtcTransport {
  close: () => Promise<void>;
  sendFrame: (frame: { tiles: any[]; width: number; height: number }) => boolean;
}

export interface ActiveFirebaseSession {
  id: string;
  deviceId: string;
}

export function isAgentFirebaseEnabled(env: AgentFirebaseEnv = process.env): boolean {
  return resolveFirebaseConfig(env) !== null;
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

  await setDoc(
    doc(services.db, "devices", device.id),
    {
      ...device,
      installId: input.installId,
      ownerUid: credential.user.uid,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return {
    devices: [device],
    device,
  };
}

export async function sendAgentHeartbeatWithFirebase(
  input: AgentHeartbeatInput,
  env: AgentFirebaseEnv = process.env,
): Promise<AgentHeartbeatResult> {
  const services = getAgentFirebaseServices(env);
  const deviceRef = doc(services.db, "devices", input.deviceId);
  const snapshot = await getDoc(deviceRef);
  if (!snapshot.exists()) {
    throwStatusError("Firebase device not found", 404);
  }

  const data = snapshot.data() as { installId?: string };
  if (data.installId && data.installId !== input.installId) {
    throwStatusError("Firebase device installId mismatch", 409);
  }

  const nowIso = new Date().toISOString();
  await updateDoc(deviceRef, {
    activeDisplayIndex: input.activeDisplayIndex,
    displays: input.displays ?? [],
    installId: input.installId,
    lastSeenAt: nowIso,
    macAddresses: input.macAddresses ?? [],
    controlDiagnostics: input.controlDiagnostics ?? null,
    status: "online",
    updatedAt: serverTimestamp(),
    version: input.version,
  });

  const updatedSnapshot = await getDoc(deviceRef);
  const device = mapFirestoreDevice(input.deviceId, {
    ...updatedSnapshot.data(),
    lastSeenAt: nowIso,
    status: "online",
    version: input.version,
    activeDisplayIndex: input.activeDisplayIndex,
    displays: input.displays ?? [],
    macAddresses: input.macAddresses ?? [],
    controlDiagnostics: input.controlDiagnostics,
  });

  return {
    devices: [device],
    device,
  };
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
    const command = commandDoc.data() as { action?: unknown; createdAt?: unknown };
    const action = typeof command.action === "string" ? command.action : "";
    if (!action) {
      batch.update(commandDoc.ref, {
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
    });
    batch.update(commandDoc.ref, {
      state: "delivered",
      deliveredAt: serverTimestamp(),
    });
  });

  if (snapshot.docs.length > 0) {
    await batch.commit();
  }

  return { commands };
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
    limit(10),
  );
  const snapshot = await getDocs(sessionsQuery);
  return snapshot.docs
    .map((sessionDoc) => ({ id: sessionDoc.id, data: sessionDoc.data() as Record<string, unknown> }))
    .filter((session) => session.data.state === "connected")
    .map((session) => ({ id: session.id, deviceId: input.deviceId }));
}

export async function postSessionTilesWithFirebase(
  sessionId: string,
  input: { tiles: any[]; width: number; height: number },
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const serialized = JSON.stringify(input);
  if (serialized.length > 850_000) {
    console.warn(`[Firebase Stream] Dropping oversized tile frame (${serialized.length} bytes).`);
    return;
  }
  const services = getAgentFirebaseServices(env);
  await addDoc(collection(services.db, "sessions", sessionId, "tileFrames"), {
    tiles: input.tiles,
    width: input.width,
    height: input.height,
    createdAt: serverTimestamp(),
  });
}

export async function startAgentWebRtcTransportWithFirebase(
  sessionId: string,
  env: AgentFirebaseEnv = process.env,
): Promise<AgentWebRtcTransport | null> {
  const services = getAgentFirebaseServices(env);
  const signalRef = doc(services.db, "sessions", sessionId, "webrtc", "signal");
  const signalSnapshot = await waitForWebRtcOffer(signalRef);
  if (!signalSnapshot) {
    return null;
  }

  const offer = signalSnapshot.offer;
  if (offer?.type !== "offer" || typeof offer.sdp !== "string") {
    return null;
  }

  const PeerConnectionCtor = await loadAgentPeerConnectionCtor();
  if (!PeerConnectionCtor) {
    return null;
  }

  const peer = new PeerConnectionCtor({
    iceServers: resolveRtcIceServers(env) as any,
    iceTransportPolicy: shouldUseRelayOnly(env) ? "relay" : "all",
  } as any);
  const agentCandidates = collection(services.db, "sessions", sessionId, "agentCandidates");
  const viewerCandidates = collection(services.db, "sessions", sessionId, "viewerCandidates");
  const appliedViewerCandidates = new Set<string>();
  let tileChannel: { readyState?: string; send?: (data: string) => void; close?: () => void } | null = null;

  peer.onicecandidate = (event: any) => {
    if (!event.candidate) {
      return;
    }
    void addDoc(agentCandidates, {
      candidate: event.candidate.toJSON(),
      createdAt: serverTimestamp(),
    });
  };

  peer.ondatachannel = (event: any) => {
    tileChannel = event.channel;
    event.channel.onopen = () => console.log("[WebRTC] Agent data channel state: open");
    event.channel.onclose = () => console.log("[WebRTC] Agent data channel state: closed");
    event.channel.onerror = () => console.warn("[WebRTC] Agent data channel error.");
  };

  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp } as any);
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await setDoc(
    signalRef,
    {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
      state: "agent-answer",
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  const candidatePoll = setInterval(() => {
    void getDocs(viewerCandidates).then((snapshot) => {
      snapshot.docs.forEach((candidateDoc) => {
        if (appliedViewerCandidates.has(candidateDoc.id)) {
          return;
        }
        appliedViewerCandidates.add(candidateDoc.id);
        const candidate = candidateDoc.data().candidate;
        if (candidate) {
          void peer.addIceCandidate(candidate as any).catch((error: unknown) => {
            console.warn(`[WebRTC] Failed to add Viewer ICE candidate: ${error instanceof Error ? error.message : error}`);
          });
        }
      });
    });
  }, 750);

  return {
    close: async () => {
      clearInterval(candidatePoll);
      tileChannel?.close?.();
      peer.close();
    },
    sendFrame: (frame) => {
      if (tileChannel?.readyState !== "open" || !tileChannel.send) {
        return false;
      }
      try {
        tileChannel.send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function loadAgentPeerConnectionCtor(): Promise<any | null> {
  try {
    const rtcModule = await import("node-datachannel/polyfill");
    return rtcModule.RTCPeerConnection;
  } catch (error) {
    console.warn(`[WebRTC] node-datachannel is unavailable; falling back to Firestore tile frames: ${error instanceof Error ? error.message : error}`);
    return null;
  }
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
  }), env);

  return {
    messages,
    clipboards,
    files,
  };
}

export async function postClipboardWithFirebase(
  sessionId: string,
  input: ClipboardData,
  env: AgentFirebaseEnv = process.env,
): Promise<void> {
  const services = getAgentFirebaseServices(env);
  await addDoc(collection(services.db, "sessions", sessionId, "clipboard"), {
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
  await addDoc(collection(services.db, "sessions", sessionId, "chat"), {
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
  await setDoc(
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
    if (data?.offer?.type === "offer" && typeof data.offer.sdp === "string") {
      return data;
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
