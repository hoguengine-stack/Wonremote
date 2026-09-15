import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  connectFirestoreEmulator,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
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
const otherAgent = createContext("other-agent", "rules-test-other-agent", "0987654321@agents.wonremote.app");
const viewer = createContext("viewer", CENTRAL_VIEWER_UID, "viewer@example.com");
const managedViewer = createContext("managed-viewer", "rules-test-managed-viewer", "staff@example.com", {
  wonremoteViewer: true,
});
const unauthorized = createContext("unauthorized", UNAUTHORIZED_UID, "unauthorized@example.com");
const timeout = setTimeout(() => { console.error("Local Firestore rules verification exceeded 30 seconds."); process.exit(1); }, 30_000);

try {
  const selectedPolicy = {targetVersion:"0.1.99",stage:"general",percentage:0,targetDeviceIds:[DEVICE_ID],paused:false};
  const policyRef = doc(viewer.db,"configuration","updateRollout");
  await setDoc(policyRef,selectedPolicy);
  const policy = (await getDoc(doc(agent.db,"configuration","updateRollout"))).data();
  if (policy.targetDeviceIds[0] !== DEVICE_ID || policy.percentage !== 0) throw new Error("Selected rollout roundtrip failed");
  await expectPermissionDenied(()=>setDoc(policyRef,{percentage:100},{merge:true}),"Legacy Viewer cannot broaden selected rollout");
  await expectPermissionDenied(()=>setDoc(policyRef,{...selectedPolicy,stage:"pilot"}),"Selected rollout requires compatibility stage");
  await expectPermissionDenied(()=>setDoc(policyRef,{...selectedPolicy,targetDeviceIds:Array(201).fill(DEVICE_ID)}),"Selected rollout size bound");
  await expectPermissionDenied(()=>setDoc(doc(agent.db,"configuration","updateRollout"),selectedPolicy),"Agent cannot choose rollout targets");
  await expectPermissionDenied(()=>setDoc(doc(unauthorized.db,"configuration","updateRollout"),selectedPolicy),"Unauthorized rollout write");
  await setDoc(policyRef,{targetDeviceIds:null,paused:true,percentage:0},{merge:true});
  await setDoc(policyRef,{percentage:100},{merge:true});
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
  const contactRef = doc(viewer.db, "devices", DEVICE_ID);
  await setDoc(contactRef, { contactPhone: "010-1234-5678" }, { merge: true });
  if ((await getDoc(contactRef)).data().contactPhone !== "010-1234-5678") throw new Error("Contact phone roundtrip failed");
  await expectPermissionDenied(() => setDoc(contactRef, { contactPhone: "1".repeat(41) }, { merge: true }), "Contact phone length");
  await expectPermissionDenied(() => setDoc(contactRef, { contactPhone: 1234 }, { merge: true }), "Contact phone type");
  await expectPermissionDenied(() => setDoc(doc(unauthorized.db, "devices", DEVICE_ID), { contactPhone: "01000000000" }, { merge: true }), "Unauthorized contact edit");
  await setDoc(contactRef, { contactPhone: deleteField() }, { merge: true });
  if ("contactPhone" in (await getDoc(contactRef)).data()) throw new Error("Contact phone clear failed");
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
  await setDoc(doc(viewer.db, "devices", DEVICE_ID), {
    desktopNameOverride: "Table 1", deviceName: "Tablet", storeName: "Store A", storeNameSource: "user",
  }, { merge: true });
  await setDoc(doc(agent.db, "devices", DEVICE_ID), { desktopName: "CTD-7000 CTD-7000", lastSeenAtServer: serverTimestamp() }, { merge: true });
  if ((await getDoc(doc(viewer.db, "devices", DEVICE_ID))).data().desktopNameOverride !== "Table 1") {
    throw new Error("Agent heartbeat overwrote the Viewer desktop name override.");
  }
  await expectPermissionDenied(() => setDoc(doc(unauthorized.db, "devices", DEVICE_ID), {
    desktopNameOverride: "unauthorized",
  }, { merge: true }), "Unauthorized desktop name edit");

  await setDoc(doc(agent.db, "devices", DEVICE_ID), {
    version: "0.1.99", selectedRolloutVersion: "0.1.99", rollbackSupportVersion: "0.1.99", lastSeenAtServer: serverTimestamp(),
  }, { merge: true });
  for (const context of [viewer, managedViewer]) {
    await expectPermissionDenied(() => setDoc(doc(context.db, "devices", DEVICE_ID), {
      rollbackSupportVersion: "0.2.0",
    }, { merge: true }), "Viewer cannot forge rollback support");
    const device = (await getDoc(doc(context.db, "devices", DEVICE_ID))).data();
    if (device.selectedRolloutVersion !== "0.1.99" || device.version !== "0.1.99") {
      throw new Error("Viewer could not read Agent selected rollout capability.");
    }
    for (const selectedRolloutVersion of ["0.2.0", null]) {
      await expectPermissionDenied(() => setDoc(doc(context.db, "devices", DEVICE_ID), {
        selectedRolloutVersion,
      }, { merge: true }), "Viewer cannot forge or clear Agent rollout capability");
    }
  }
  await expectPermissionDenied(() => setDoc(doc(unauthorized.db, "devices", DEVICE_ID), {
    selectedRolloutVersion: "0.2.0",
  }, { merge: true }), "Non-owner cannot change Agent rollout capability");
  await expectPermissionDenied(() => setDoc(doc(otherAgent.db, "devices", DEVICE_ID), {
    selectedRolloutVersion: "0.2.0",
  }, { merge: true }), "Another Agent cannot change rollout capability");
  await setDoc(doc(agent.db, "devices", DEVICE_ID), {
    selectedRolloutVersion: null,
  }, { merge: true });
  if ((await getDoc(doc(viewer.db, "devices", DEVICE_ID))).data().selectedRolloutVersion !== null) {
    throw new Error("Agent capability withdrawal was not visible to Viewer.");
  }
  const rollbackCommand = `rollback-test-${Date.now()}`;
  const rollbackBatch = writeBatch(viewer.db);
  rollbackBatch.update(doc(viewer.db, "devices", DEVICE_ID), { updatePaused: true, updatedAt: serverTimestamp() });
  rollbackBatch.set(doc(viewer.db, "devices", DEVICE_ID, "commands", rollbackCommand), {
    action: `request-rollback 0.1.90 ${Date.now()}`, state: "pending", createdAt: serverTimestamp(),
  });
  await rollbackBatch.commit();
  if (!(await getDoc(doc(agent.db, "devices", DEVICE_ID))).data().updatePaused
      || !(await getDoc(doc(agent.db, "devices", DEVICE_ID, "commands", rollbackCommand))).exists()) {
    throw new Error("Agent did not observe atomic rollback pause and command.");
  }
  const deniedBatch = writeBatch(unauthorized.db);
  deniedBatch.update(doc(unauthorized.db, "devices", DEVICE_ID), { updatePaused: false });
  deniedBatch.set(doc(unauthorized.db, "devices", DEVICE_ID, "commands", `${rollbackCommand}-denied`), { action: "request-rollback 0.1.90 1700000000000", state: "pending" });
  await expectPermissionDenied(() => deniedBatch.commit(), "Unauthorized rollback batch");
  if (!(await getDoc(doc(viewer.db, "devices", DEVICE_ID))).data().updatePaused
      || (await getDoc(doc(viewer.db, "devices", DEVICE_ID, "commands", `${rollbackCommand}-denied`))).exists()) {
    throw new Error("Denied rollback batch partially persisted.");
  }
  await deleteDoc(doc(viewer.db, "devices", DEVICE_ID, "commands", rollbackCommand));
  await setDoc(doc(viewer.db, "devices", DEVICE_ID), { updatePaused: false }, { merge: true });

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
  const staleSeed = await fetch(`http://${emulatorHost}/v1/projects/wonremote-a7fd3/databases/(default)/documents/devices/${DEVICE_ID}?updateMask.fieldPaths=lastSeenAtServer`, {
    method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ fields: { lastSeenAtServer: { timestampValue: "2020-01-01T00:00:00Z" } } }),
  });
  if (!staleSeed.ok) throw new Error(`Stale emulator seed failed: ${staleSeed.status}`);
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
    selectedRolloutCapabilityOwnership: true,
  }));
} finally {
  clearTimeout(timeout);
  await Promise.all([agent.app, otherAgent.app, viewer.app, managedViewer.app, unauthorized.app].map((app) => deleteApp(app)));
}
