import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  where,
} from "firebase/firestore";

const CENTRAL_VIEWER_UID = "Xjjdvk0Nx1eqCvND4yIOHbM53tl1";
const AGENT_UID = "rules-test-agent-uid";
const UNAUTHORIZED_UID = "rules-test-unauthorized-uid";
const DEVICE_ID = "123-45-67890:AGENT-RULESTEST";
const SESSION_ID = "rules-test-session";
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

if (!emulatorHost) {
  throw new Error("FIRESTORE_EMULATOR_HOST is required. Run this script through Firebase emulators:exec.");
}

const separator = emulatorHost.lastIndexOf(":");
const host = emulatorHost.slice(0, separator);
const port = Number(emulatorHost.slice(separator + 1));
if (!host || !Number.isInteger(port)) {
  throw new Error(`Invalid FIRESTORE_EMULATOR_HOST: ${emulatorHost}`);
}

function createContext(name, uid, email) {
  const app = initializeApp({
    apiKey: "rules-test-api-key",
    appId: `rules-test-${name}`,
    projectId: "wonremote-a7fd3",
  }, name);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, port, {
    mockUserToken: {
      sub: uid,
      email,
      email_verified: true,
    },
  });
  return { app, db };
}

async function expectPermissionDenied(operation, label) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === "permission-denied") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

const agent = createContext("agent", AGENT_UID, "1234567890@agents.wonremote.app");
const viewer = createContext("viewer", CENTRAL_VIEWER_UID, "viewer@example.com");
const unauthorized = createContext("unauthorized", UNAUTHORIZED_UID, "unauthorized@example.com");

try {
  await setDoc(doc(agent.db, "devices", DEVICE_ID), {
    id: DEVICE_ID,
    ownerUid: AGENT_UID,
    businessNumber: "123-45-67890",
    deviceNumber: "AGENT-RULESTEST",
    installId: "rules-test-install",
    status: "online",
  });

  const viewerDevices = await getDocs(collection(viewer.db, "devices"));
  if (!viewerDevices.docs.some((snapshot) => snapshot.id === DEVICE_ID)) {
    throw new Error("Central Viewer could not list the Agent device.");
  }

  await expectPermissionDenied(
    () => getDocs(collection(unauthorized.db, "devices")),
    "Unauthorized device list",
  );

  await setDoc(doc(viewer.db, "sessions", SESSION_ID), {
    id: SESSION_ID,
    ownerUid: CENTRAL_VIEWER_UID,
    deviceId: DEVICE_ID,
    state: "connected",
  });

  const agentSessions = await getDocs(query(
    collection(agent.db, "sessions"),
    where("deviceId", "==", DEVICE_ID),
    where("state", "==", "connected"),
  ));
  if (!agentSessions.docs.some((snapshot) => snapshot.id === SESSION_ID)) {
    throw new Error("Agent could not read the central Viewer session for its device.");
  }

  await setDoc(doc(viewer.db, "devices", DEVICE_ID, "commands", "rules-test-command"), {
    action: `start-stream ${SESSION_ID}`,
    state: "pending",
  });

  await expectPermissionDenied(
    () => deleteDoc(doc(agent.db, "devices", DEVICE_ID)),
    "Agent device deletion",
  );
  await expectPermissionDenied(
    () => deleteDoc(doc(unauthorized.db, "devices", DEVICE_ID)),
    "Unauthorized device deletion",
  );
  await deleteDoc(doc(viewer.db, "devices", DEVICE_ID, "commands", "rules-test-command"));
  await deleteDoc(doc(viewer.db, "devices", DEVICE_ID));
  if ((await getDoc(doc(viewer.db, "devices", DEVICE_ID))).exists()) {
    throw new Error("Central Viewer device deletion did not remove the device.");
  }

  console.log(JSON.stringify({
    agentSessionAccess: true,
    centralViewerDeviceAccess: true,
    unauthorizedViewerDenied: true,
    centralViewerDeviceDeletion: true,
  }));
} finally {
  await Promise.all([agent.app, viewer.app, unauthorized.app].map((app) => deleteApp(app)));
}
