import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from "firebase/firestore";
import type { AgentFirstRunInput, AgentFirstRunResult, ManagedDevice, RemoteSession } from "../domain/types";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { buildAgentAuthEmail, buildAgentAuthPassword } from "./firebaseIdentity";
import { buildFirestoreDevice, mapFirestoreDevice } from "./firestoreDevice";
import { getWonRemoteFirebaseServices } from "./firebaseServices";

type ViewerFirebaseEnv = ImportMetaEnv;

export function isViewerFirebaseEnabled(env: ViewerFirebaseEnv = import.meta.env): boolean {
  return resolveFirebaseConfig(env) !== null;
}

export async function loginViewerWithFirebase(
  username: string,
  password: string,
  env: ViewerFirebaseEnv = import.meta.env,
): Promise<void> {
  const services = getViewerFirebaseServices(env);
  await signInWithEmailAndPassword(services.auth, username.trim(), password);
}

export function subscribeFirebaseDevices(
  onDevices: (devices: ManagedDevice[]) => void,
  onError: (error: Error) => void,
  env: ViewerFirebaseEnv = import.meta.env,
): Unsubscribe {
  const services = getViewerFirebaseServices(env);
  const devicesQuery = query(collection(services.db, "devices"), orderBy("storeName"), orderBy("deviceNumber"));

  return onSnapshot(
    devicesQuery,
    (snapshot) => {
      onDevices(snapshot.docs.map((deviceDoc) => mapFirestoreDevice(deviceDoc.id, deviceDoc.data())));
    },
    (error) => onError(error),
  );
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
        throw error;
      }
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

function firebaseSessionIdForDevice(deviceId: string): string {
  return `session-${deviceId}`;
}

function deviceIdFromFirebaseSessionId(sessionId: string): string {
  if (!sessionId.startsWith("session-")) {
    throw new Error("Invalid Firebase session id.");
  }
  return sessionId.slice("session-".length);
}
