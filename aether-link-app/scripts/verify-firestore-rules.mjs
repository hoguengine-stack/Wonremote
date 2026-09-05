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
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";

const CENTRAL_VIEWER_UID = "Xjjdvk0Nx1eqCvND4yIOHbM53tl1";
const AGENT_UID = "rules-test-agent-uid";
const UNAUTHORIZED_UID = "rules-test-unauthorized-uid";
const DEVICE_ID = "123-45-67890:AGENT-RULESTEST";
const SESSION_ID = `rules-test-session-${Date.now()}`;
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

function createContext(name, uid, email, claims = {}) {
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
      ...claims,
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
const managedViewer = createContext("managed-viewer", "rules-test-managed-viewer", "staff@example.com", {
  wonremoteViewer: true,
});
const unauthorized = createContext("unauthorized", UNAUTHORIZED_UID, "unauthorized@example.com");
const timeout = setTimeout(() => { console.error("Local Firestore rules verification exceeded 30 seconds."); process.exit(1); }, 30_000);

try {
  await setDoc(doc(agent.db, "devices", DEVICE_ID), {
    id: DEVICE_ID,
    ownerUid: AGENT_UID,
    businessNumber: "123-45-67890",
    deviceNumber: "AGENT-RULESTEST",
    installId: "rules-test-install",
    status: "online",
    presenceMode: "manual",
    lastSeenAtServer: serverTimestamp(),
  });

  // This seed is emulator-only: exercise a long-idle Agent without waiting a minute.
  const seeded = await fetch(`http://${emulatorHost}/v1/projects/wonremote-a7fd3/databases/(default)/documents/devices/${encodeURIComponent(DEVICE_ID)}?updateMask.fieldPaths=lastSeenAtServer`, {
    method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ fields: { lastSeenAtServer: { timestampValue: "2020-01-01T00:00:00Z" } } }),
  });
  if (!seeded.ok) throw new Error(`Emulator seed failed: ${seeded.status}`);

  const viewerDevices = await getDocs(collection(viewer.db, "devices"));
  if (!viewerDevices.docs.some((snapshot) => snapshot.id === DEVICE_ID)) {
    throw new Error("Central Viewer could not list the Agent device.");
  }
  const managedViewerDevices = await getDocs(collection(managedViewer.db, "devices"));
  if (!managedViewerDevices.docs.some((snapshot) => snapshot.id === DEVICE_ID)) {
    throw new Error("Managed Viewer claim could not list the Agent device.");
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

  await expectPermissionDenied(() => setDoc(doc(unauthorized.db, "sessions", `${SESSION_ID}-unauthorized`), {
    id: `${SESSION_ID}-unauthorized`, ownerUid: UNAUTHORIZED_UID, deviceId: DEVICE_ID, state: "connected",
  }), "Unauthorized manual-presence connection");
  await setDoc(doc(agent.db, "devices", DEVICE_ID), { presenceMode: "periodic" }, { merge: true });
  await expectPermissionDenied(() => setDoc(doc(viewer.db, "sessions", `${SESSION_ID}-stale-legacy`), {
    id: `${SESSION_ID}-stale-legacy`, ownerUid: CENTRAL_VIEWER_UID, deviceId: DEVICE_ID, state: "connected",
  }), "Stale legacy presence connection");
  await setDoc(doc(agent.db, "devices", DEVICE_ID), { presenceMode: "manual" }, { merge: true });

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
    managedViewerDeviceAccess: true,
    unauthorizedViewerDenied: true,
    centralViewerDeviceDeletion: true,
    manualPresenceConnection: true,
    staleLegacyConnectionDenied: true,
  }));
} finally {
  clearTimeout(timeout);
  await Promise.all([agent.app, viewer.app, managedViewer.app, unauthorized.app].map((app) => deleteApp(app)));
}
