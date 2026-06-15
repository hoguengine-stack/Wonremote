import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
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
} from "../domain/types";
import { resolveFirebaseConfig } from "./firebaseConfig";
import { buildAgentAuthEmail, buildAgentAuthPassword } from "./firebaseIdentity";
import { buildFirestoreDevice, mapFirestoreDevice } from "./firestoreDevice";
import { getWonRemoteFirebaseServices } from "./firebaseServices";
import { throwExplainedFirebaseAuthError } from "./firebaseError";

type AgentFirebaseEnv = Record<string, string | undefined>;

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
