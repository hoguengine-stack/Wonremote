import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { randomUUID } from "node:crypto";
import { generateSecurityCode } from "./securityCode.js";
import { normalizeWakeMac, selectWakeRelay } from "./wakeRelay.js";

initializeApp();

const db = getFirestore();
const SECURE_SESSION_TTL_MS = 120_000;

type DeviceDocument = {
  businessNumber?: string;
  lastSeenAt?: unknown;
  macAddresses?: unknown;
  ownerUid?: string;
  status?: string;
};

type ChallengeDocument = {
  code?: string;
  deviceId?: string;
  expiresAtMs?: number;
  ownerUid?: string;
  state?: string;
};

type SessionDocument = {
  deviceId?: string;
  ownerUid?: string;
  state?: string;
};

export const requestSecureSession = onCall(async (request) => {
  const uid = requireAuthUid(request.auth?.uid);
  const deviceId = requireString(request.data?.deviceId, "deviceId");
  const device = await readOwnedOnlineDevice(deviceId, uid);
  const nowMs = Date.now();
  const challengeId = `secure-${randomUUID()}`;
  const code = generateSecurityCode();
  const expiresAtMs = nowMs + SECURE_SESSION_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  await db.runTransaction(async (transaction) => {
    transaction.set(db.collection("secureChallenges").doc(challengeId), {
      challengeId,
      code,
      createdAt: FieldValue.serverTimestamp(),
      deviceId,
      expiresAt,
      expiresAtMs,
      ownerUid: uid,
      state: "pending",
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(db.collection("devices").doc(deviceId).collection("commands").doc(), {
      action: `security-code ${challengeId} ${code}`,
      createdAt: FieldValue.serverTimestamp(),
      state: "pending",
    });
  });

  return {
    challengeId,
    deviceId: device.id,
    expiresAt,
  };
});

export const connectSecureSession = onCall(async (request) => {
  const uid = requireAuthUid(request.auth?.uid);
  const challengeId = requireString(request.data?.challengeId, "challengeId");
  const deviceId = requireString(request.data?.deviceId, "deviceId");
  const code = normalizeSecurityCode(requireString(request.data?.code, "code"));
  let result: { inputLog: string[]; session: SessionResponse } | null = null;

  await db.runTransaction(async (transaction) => {
    const challengeRef = db.collection("secureChallenges").doc(challengeId);
    const challengeSnapshot = await transaction.get(challengeRef);
    if (!challengeSnapshot.exists) {
      throw new HttpsError("not-found", "Invalid secure connection code.");
    }

    const challenge = challengeSnapshot.data() as ChallengeDocument;
    if (challenge.ownerUid !== uid || challenge.deviceId !== deviceId || challenge.state !== "pending") {
      throw new HttpsError("permission-denied", "Invalid secure connection code.");
    }
    if (!challenge.expiresAtMs || challenge.expiresAtMs <= Date.now()) {
      transaction.update(challengeRef, {
        state: "expired",
        updatedAt: FieldValue.serverTimestamp(),
      });
      throw new HttpsError("deadline-exceeded", "Secure connection code expired.");
    }
    if (normalizeSecurityCode(challenge.code ?? "") !== code) {
      throw new HttpsError("permission-denied", "Invalid secure connection code.");
    }

    transaction.update(challengeRef, {
      state: "used",
      updatedAt: FieldValue.serverTimestamp(),
      usedAt: FieldValue.serverTimestamp(),
    });
    result = queueOpenSession(transaction, deviceId, uid);
  });

  if (!result) {
    throw new HttpsError("internal", "Secure session was not created.");
  }
  return result;
});

export const openSession = onCall(async (request) => {
  const uid = requireAuthUid(request.auth?.uid);
  const deviceId = requireString(request.data?.deviceId, "deviceId");
  await readOwnedOnlineDevice(deviceId, uid);

  return db.runTransaction(async (transaction) => queueOpenSession(transaction, deviceId, uid));
});

export const enqueueCommand = onCall(async (request) => {
  const uid = requireAuthUid(request.auth?.uid);
  const sessionId = requireString(request.data?.sessionId, "sessionId");
  const action = requireString(request.data?.action, "action");
  await db.runTransaction(async (transaction) => {
    const session = await readOwnedConnectedSession(transaction, sessionId, uid);
    transaction.set(db.collection("devices").doc(session.deviceId!).collection("commands").doc(), {
      action,
      createdAt: FieldValue.serverTimestamp(),
      state: "pending",
    });
  });
  return {
    inputLog: [`${new Date().toLocaleTimeString()} ${action}`],
  };
});

export const closeSession = onCall(async (request) => {
  const uid = requireAuthUid(request.auth?.uid);
  const sessionId = requireString(request.data?.sessionId, "sessionId");
  await db.runTransaction(async (transaction) => {
    const sessionRef = db.collection("sessions").doc(sessionId);
    const sessionSnapshot = await transaction.get(sessionRef);
    if (!sessionSnapshot.exists) {
      throw new HttpsError("not-found", "Firebase session not found.");
    }

    const session = sessionSnapshot.data() as SessionDocument;
    if (session.ownerUid !== uid || !session.deviceId) {
      throw new HttpsError("permission-denied", "Session is not owned by this account.");
    }
    if (session.state !== "connected") {
      throw new HttpsError("failed-precondition", "Only connected sessions can be closed.");
    }

    transaction.update(sessionRef, {
      closedAt: FieldValue.serverTimestamp(),
      state: "closed",
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(db.collection("devices").doc(session.deviceId).collection("commands").doc(), {
      action: `stop-stream ${sessionId}`,
      createdAt: FieldValue.serverTimestamp(),
      state: "pending",
    });
  });

  return null;
});

export const wakeDevice = onCall(async (request) => {
  const uid = requireAuthUid(request.auth?.uid);
  const targetDeviceId = requireString(request.data?.targetDeviceId, "targetDeviceId");
  const target = await readOwnedDevice(targetDeviceId, uid);
  const businessNumber = requireDocumentString(target.businessNumber, "Target device businessNumber is missing.");
  const storedMacAddresses = Array.isArray(target.macAddresses)
    ? target.macAddresses.map(normalizeWakeMac).filter((mac): mac is string => Boolean(mac))
    : [];
  const requestedMac = request.data?.targetMac === undefined
    ? undefined
    : normalizeWakeMac(request.data.targetMac);
  if (request.data?.targetMac !== undefined && !requestedMac) {
    throw new HttpsError("invalid-argument", "targetMac must be a valid unicast MAC address.");
  }
  const targetMac = requestedMac ?? storedMacAddresses[0];
  if (!targetMac) {
    throw new HttpsError("failed-precondition", "Target device does not have a valid heartbeat MAC address.");
  }
  if (requestedMac && !storedMacAddresses.includes(requestedMac)) {
    throw new HttpsError("permission-denied", "targetMac is not registered to the target device.");
  }

  const nowMs = Date.now();
  const relaySnapshot = await db.collection("devices").where("ownerUid", "==", uid).get();
  const relay = selectWakeRelay(
    relaySnapshot.docs.map((relayDoc) => ({
      id: relayDoc.id,
      ...(relayDoc.data() as DeviceDocument),
    })),
    { businessNumber, nowMs, ownerUid: uid, targetDeviceId },
  );
  if (!relay) {
    throw new HttpsError(
      "failed-precondition",
      "No recent online relay Agent is available for the target business.",
    );
  }

  await db.runTransaction(async (transaction) => {
    const relayRef = db.collection("devices").doc(relay.id);
    const relayDocument = await transaction.get(relayRef);
    const currentRelay = relayDocument.exists
      ? selectWakeRelay(
          [{ id: relayDocument.id, ...(relayDocument.data() as DeviceDocument) }],
          { businessNumber, nowMs: Date.now(), ownerUid: uid, targetDeviceId },
        )
      : null;
    if (!currentRelay) {
      throw new HttpsError(
        "failed-precondition",
        "The selected Wake-on-LAN relay Agent is no longer online.",
      );
    }
    transaction.set(relayRef.collection("commands").doc(), {
      action: `wake-on-lan ${targetMac}`,
      createdAt: FieldValue.serverTimestamp(),
      state: "pending",
    });
  });

  return {
    relayDeviceId: relay.id,
    targetDeviceId,
    targetMac,
  };
});

interface SessionResponse {
  deviceId: string;
  id: string;
  startedAt: string;
  state: "connected";
}

function queueOpenSession(
  transaction: FirebaseFirestore.Transaction,
  deviceId: string,
  ownerUid: string,
): { inputLog: string[]; session: SessionResponse } {
  const startedAt = new Date().toISOString();
  const sessionRef = db.collection("sessions").doc();
  const session: SessionResponse = {
    deviceId,
    id: sessionRef.id,
    startedAt,
    state: "connected",
  };
  transaction.set(
    sessionRef,
    {
      ...session,
      createdAt: FieldValue.serverTimestamp(),
      ownerUid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  transaction.set(db.collection("devices").doc(deviceId).collection("commands").doc(), {
    action: `start-stream ${session.id}`,
    createdAt: FieldValue.serverTimestamp(),
    state: "pending",
  });
  return {
    inputLog: [`${new Date().toLocaleTimeString()} start-stream queued via Firebase`],
    session,
  };
}

async function readOwnedOnlineDevice(deviceId: string, uid: string): Promise<DeviceDocument & { id: string }> {
  const device = await readOwnedDevice(deviceId, uid);
  if (device.status !== "online") {
    throw new HttpsError("failed-precondition", "Only online agents can accept connections.");
  }
  return device;
}

async function readOwnedDevice(deviceId: string, uid: string): Promise<DeviceDocument & { id: string }> {
  const snapshot = await db.collection("devices").doc(deviceId).get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Firebase device not found.");
  }

  const device = snapshot.data() as DeviceDocument;
  if (device.ownerUid !== uid) {
    throw new HttpsError("permission-denied", "Device is not owned by this account.");
  }
  return {
    ...device,
    id: snapshot.id,
  };
}

async function readOwnedConnectedSession(
  transaction: FirebaseFirestore.Transaction,
  sessionId: string,
  uid: string,
): Promise<SessionDocument & { id: string }> {
  const snapshot = await transaction.get(db.collection("sessions").doc(sessionId));
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Firebase session not found.");
  }

  const session = snapshot.data() as SessionDocument;
  if (session.ownerUid !== uid) {
    throw new HttpsError("permission-denied", "Session is not owned by this account.");
  }
  if (session.state !== "connected" || !session.deviceId) {
    throw new HttpsError("failed-precondition", "Only connected sessions can send remote input.");
  }
  return {
    ...session,
    id: snapshot.id,
  };
}

function requireAuthUid(uid: string | undefined): string {
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  return uid;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }
  return value.trim();
}

function requireDocumentString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("failed-precondition", message);
  }
  return value.trim();
}

function normalizeSecurityCode(value: string): string {
  return value.replace(/\D/g, "");
}
