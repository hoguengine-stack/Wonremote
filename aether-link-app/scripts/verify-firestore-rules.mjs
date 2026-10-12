import { deleteApp, initializeApp } from "firebase/app";
import { randomUUID } from "node:crypto";
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
    storeName: "규칙 테스트 매장", storeNameSource: "user", deviceName: "메인포스",
    status: "online",
    presenceMode: "manual",
    lastSeenAtServer: serverTimestamp(),
  });

  // This seed is emulator-only: exercise a long-idle Agent without waiting a minute.
  const contactRef = doc(viewer.db, "devices", DEVICE_ID);
  const businessBatch = writeBatch(viewer.db);
  businessBatch.update(contactRef, {businessNumber:"987-65-43210"});
  businessBatch.set(doc(viewer.db,"devices",DEVICE_ID,"commands","business-sync"), {action:"sync-business-number",state:"pending",createdAt:serverTimestamp()});
  await businessBatch.commit();
  if ((await getDoc(doc(agent.db,"devices",DEVICE_ID))).data().businessNumber !== "987-65-43210") throw new Error("Agent cannot read edited business number");
  await setDoc(doc(agent.db,"devices",DEVICE_ID), {lastSeenAtServer:serverTimestamp()}, {merge:true});
  await expectPermissionDenied(() => setDoc(contactRef,{businessNumber:"bad"},{merge:true}),"Invalid business number");
  const selfRef=doc(agent.db,"devices",DEVICE_ID);
  const selfBatch=writeBatch(agent.db);
  selfBatch.update(selfRef,{businessNumber:"111-22-33333",storeName:"Agent 수정 매장",storeNameSource:"user",deviceName:"오더포스",updatedAt:serverTimestamp()});
  selfBatch.set(doc(agent.db,"devices",DEVICE_ID,"commands","self-business-sync"),{action:"sync-business-number",state:"pending",createdAt:serverTimestamp()});
  await selfBatch.commit();
  const selfDevice=(await getDoc(selfRef)).data();
  if(selfDevice.businessNumber!=="111-22-33333" || selfDevice.ownerUid!==AGENT_UID || selfDevice.installId!=="rules-test-install" || selfDevice.deviceName!=="오더포스") throw new Error("Owned Agent metadata update lost identity");
  for(const [label,patch] of [["invalid number",{businessNumber:"invalid"}],["owner",{businessNumber:"123-45-67890",ownerUid:UNAUTHORIZED_UID}],["install",{businessNumber:"123-45-67890",installId:"other"}],["update policy",{businessNumber:"123-45-67890",updatePaused:true}],["ZOOK",{businessNumber:"123-45-67890",zookNumber:"00123456"}],["oversized type",{businessNumber:"123-45-67890",deviceName:"x".repeat(101)}]]) {
    await expectPermissionDenied(()=>setDoc(selfRef,patch,{merge:true}),`Agent metadata rejects ${label}`);
  }
  await expectPermissionDenied(()=>setDoc(doc(otherAgent.db,"devices",DEVICE_ID),{businessNumber:"123-45-67890"},{merge:true}),"Different Agent cannot edit device");
  await deleteDoc(doc(viewer.db,"devices",DEVICE_ID,"commands","self-business-sync"));
  await expectPermissionDenied(() => setDoc(doc(unauthorized.db,"devices",DEVICE_ID),{businessNumber:"123-45-67890"},{merge:true}),"Unauthorized business edit");
  await expectPermissionDenied(() => setDoc(contactRef,{ownerUid:UNAUTHORIZED_UID},{merge:true}),"Business edit cannot change owner");
  await expectPermissionDenied(() => setDoc(contactRef,{installId:"changed"},{merge:true}),"Business edit cannot change install identity");
  await setDoc(contactRef,{businessNumber:"123-45-67890"},{merge:true});
  await deleteDoc(doc(viewer.db,"devices",DEVICE_ID,"commands","business-sync"));
  const zookBatch=writeBatch(viewer.db);
  zookBatch.update(contactRef,{zookNumber:"00123456",zookError:deleteField()});
  zookBatch.set(doc(viewer.db,"devices",DEVICE_ID,"commands","zook-setting"),{action:"configure-zook",state:"pending",createdAt:serverTimestamp()});
  await zookBatch.commit();
  if ((await getDoc(doc(agent.db,"devices",DEVICE_ID))).data().zookNumber !== "00123456") throw new Error("ZOOK number read failed");
  await setDoc(doc(agent.db,"devices",DEVICE_ID),{zookAppliedNumber:"00123456",zookError:""},{merge:true});
  await expectPermissionDenied(()=>setDoc(contactRef,{zookNumber:"1234abcd"},{merge:true}),"Invalid ZOOK number");
  await expectPermissionDenied(()=>setDoc(doc(unauthorized.db,"devices",DEVICE_ID),{zookNumber:"87654321"},{merge:true}),"Unauthorized ZOOK number");
  await expectPermissionDenied(()=>setDoc(doc(agent.db,"devices",DEVICE_ID),{zookNumber:"87654321"},{merge:true}),"Agent cannot replace Viewer requested number");
  await expectPermissionDenied(()=>setDoc(contactRef,{zookAppliedNumber:"87654321"},{merge:true}),"Viewer cannot fake ZOOK native success");
  await deleteDoc(doc(viewer.db,"devices",DEVICE_ID,"commands","zook-setting"));
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

  const lockedDevice = `${DEVICE_ID}-LOCK`;
  const lockVersion = randomUUID();
  const lockedSession = `${SESSION_ID}-locked`;
  const lockRef = doc(agent.db, "deviceAccessLocks", lockedDevice);
  await setDoc(doc(agent.db, "devices", lockedDevice), {
    id:lockedDevice, ownerUid:AGENT_UID, businessNumber:"123-45-67890", deviceNumber:"LOCK",
    installId:"lock-install", status:"online", presenceMode:"manual", lastSeenAtServer:serverTimestamp(),
    accessLocked:true, accessLockVersion:lockVersion, accessPublicKey:"A".repeat(392),
  });
  await setDoc(lockRef, {enabled:true, version:lockVersion, updatedAt:serverTimestamp()});
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"deviceAccessLocks",lockedDevice), {enabled:false,version:lockVersion,updatedAt:serverTimestamp()}), "Viewer cannot disable authoritative lock directly");
  await expectPermissionDenied(()=>getDoc(doc(viewer.db,"deviceAccessLocks",lockedDevice)), "Viewer cannot read private access state");
  const sessionBody = {id:lockedSession,ownerUid:CENTRAL_VIEWER_UID,deviceId:lockedDevice,state:"connected"};
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"sessions",lockedSession),sessionBody), "Old Viewer cannot connect locked device");
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"devices",lockedDevice,"commands","bypass-start"),{action:`start-stream ${lockedSession}`,state:"pending"}), "Raw stream command cannot bypass lock");
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"devices",lockedDevice,"commands","bypass-system"),{action:"system cmd",state:"pending"}), "Sessionless command cannot bypass lock");
  await expectPermissionDenied(()=>deleteDoc(doc(viewer.db,"devices",lockedDevice)), "Device deletion cannot remove a locked target");
  const accessId = randomUUID();
  const accessRef = doc(viewer.db,"deviceAccessRequests",accessId);
  await setDoc(accessRef,{id:accessId,deviceId:lockedDevice,ownerUid:CENTRAL_VIEWER_UID,operation:"connect",sessionId:lockedSession,
    lockVersion,key:"A".repeat(344),iv:"A".repeat(16),ciphertext:"A".repeat(160),state:"pending",createdAt:serverTimestamp()});
  await expectPermissionDenied(()=>setDoc(accessRef,{state:"approved",approvedVersion:lockVersion,updatedAt:serverTimestamp()},{merge:true}), "Viewer cannot approve own password request");
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"sessions",lockedSession),{...sessionBody,accessRequestId:accessId,accessLockVersion:lockVersion}), "Pending proof is not authorization");
  await setDoc(doc(agent.db,"deviceAccessRequests",accessId),{state:"approved",approvedVersion:lockVersion,approvalSignature:"A".repeat(344),updatedAt:serverTimestamp()},{merge:true});
  await expectPermissionDenied(()=>setDoc(doc(managedViewer.db,"sessions",`${lockedSession}-other`),{...sessionBody,id:`${lockedSession}-other`,ownerUid:"rules-test-managed-viewer",accessRequestId:accessId,accessLockVersion:lockVersion}), "Different Viewer cannot reuse grant");
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"sessions",`${lockedSession}-replay`),{...sessionBody,id:`${lockedSession}-replay`,accessRequestId:accessId,accessLockVersion:lockVersion}), "Different session cannot replay grant");
  const accepted = writeBatch(viewer.db);
  accepted.set(doc(viewer.db,"sessions",lockedSession), {...sessionBody,accessRequestId:accessId,accessLockVersion:lockVersion});
  accepted.set(doc(viewer.db,"devices",lockedDevice,"commands","authorized-start"),{action:`start-stream ${lockedSession}`,sessionId:lockedSession,state:"pending"});
  await accepted.commit();
  await setDoc(doc(viewer.db,"sessions",lockedSession,"chat","before-change"),{text:"authorized"});
  await setDoc(lockRef,{enabled:true,version:randomUUID(),updatedAt:serverTimestamp()});
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"sessions",lockedSession,"chat","after-change"),{text:"old grant"}), "Password change revokes previous session data authorization");
  await expectPermissionDenied(()=>setDoc(doc(viewer.db,"devices",lockedDevice,"commands","after-change"),{action:"system cmd",sessionId:lockedSession,state:"pending"}), "Password change revokes previous input authorization");
  await setDoc(lockRef,{enabled:false,version:randomUUID(),updatedAt:serverTimestamp()});
  await setDoc(doc(viewer.db,"sessions",`${lockedSession}-unlocked`),{...sessionBody,id:`${lockedSession}-unlocked`});

  console.log(JSON.stringify({
    deviceAccessLockOldViewerAndCommandBypassDenied:true,
    deviceAccessLockViewerAndSessionBinding:true,
    deviceAccessLockPasswordChangeRevokesOldGrant:true,
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
