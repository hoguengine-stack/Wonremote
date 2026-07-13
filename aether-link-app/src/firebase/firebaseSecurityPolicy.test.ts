import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..");

describe("Firebase security deployment policy", () => {
  it("declares a Cloud Functions source for server-side session and command validation", () => {
    const firebaseConfig = JSON.parse(readFileSync(resolve(repoRoot, "firebase.json"), "utf8")) as {
      functions?: { source?: string };
    };

    expect(firebaseConfig.functions?.source).toBe("functions");
  });

  it("keeps an executable Firestore emulator regression for Viewer and Agent role boundaries", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "aether-link-app/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const verifier = readFileSync(resolve(repoRoot, "aether-link-app/scripts/verify-firestore-rules.mjs"), "utf8");

    expect(packageJson.scripts?.["firebase:rules:test"]).toContain("verify-firestore-rules.mjs");
    expect(verifier).toContain("Unauthorized device list");
    expect(verifier).toContain("Agent could not read the central Viewer session for its device.");
  });

  it("allows Spark-compatible direct session commands only for owned devices", () => {
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");

    expect(rules).toContain("match /commands/{commandId}");
    expect(rules).toContain("function isOwnDeviceCommandCreate(deviceId)");
    expect(rules).toContain("allow create: if isOwnDeviceCommandCreate(deviceId);");
    expect(rules).toContain("request.resource.data.action is string");
    expect(rules).toContain('request.resource.data.state == "pending"');
  });

  it("keeps device ownership and identity fields immutable on client updates", () => {
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");

    expect(rules).toContain("function isOwnDeviceUpdate(deviceId)");
    expect(rules).toContain("isCentralViewerDeviceUpdate() || isOwnDeviceUpdate(deviceId)");
    expect(rules).toContain("request.resource.data.ownerUid == resource.data.ownerUid");
    expect(rules).toContain("request.resource.data.businessNumber == resource.data.businessNumber");
    expect(rules).toContain("request.resource.data.deviceNumber == resource.data.deviceNumber");
    expect(rules).toContain("request.resource.data.installId == resource.data.installId");
  });

  it("authorizes central Viewer device list queries while keeping Agent ownership checks", () => {
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");
    const viewerFirebase = readFileSync(resolve(repoRoot, "aether-link-app/src/firebase/viewerFirebase.ts"), "utf8");
    const deviceMatch = rules.match(/match \/devices\/\{deviceId\} \{([\s\S]*?)match \/commands/);
    const deviceListBlock = viewerFirebase.slice(
      viewerFirebase.indexOf("export function subscribeFirebaseDevices"),
      viewerFirebase.indexOf("export async function fetchFirebaseConnectionHistory"),
    );
    const sessionOpenBlock = viewerFirebase.slice(
      viewerFirebase.indexOf("async function openFirebaseSessionDirect"),
      viewerFirebase.indexOf("async function recordFirebaseInputDirect"),
    );

    expect(rules).toContain("function isCentralViewer()");
    expect(rules).toContain('request.auth.uid in [');
    expect(rules).toContain('"Xjjdvk0Nx1eqCvND4yIOHbM53tl1"');
    expect(viewerFirebase).toContain('const CENTRAL_VIEWER_UIDS = new Set(["Xjjdvk0Nx1eqCvND4yIOHbM53tl1"]);');
    expect(rules).not.toContain('!request.auth.token.email.matches(".*@agents[.]wonremote[.]app")');
    expect(deviceMatch?.[1]).toContain("allow get: if isCentralViewer()");
    expect(deviceMatch?.[1]).toContain("allow list: if isCentralViewer()");
    expect(deviceMatch?.[1]).toContain("allow update: if isCentralViewerDeviceUpdate() || isOwnDeviceUpdate(deviceId);");
    expect(deviceMatch?.[1]).toContain("isOwnDeviceUpdate(deviceId)");
    expect(deviceListBlock).not.toContain('where("ownerUid", "==", userId)');
    expect(sessionOpenBlock).not.toContain("device.ownerUid !== userId");
  });

  it("requires explicit session subcollection rules instead of recursive wildcard access", () => {
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");

    expect(rules).toContain("function ownsSession(sessionId)");
    expect(rules).toContain("function isOwnSessionCreate(sessionId)");
    expect(rules).toContain("function canAccessSession(sessionId)");
    expect(rules).toContain("function canReadSession()");
    expect(rules).toContain("function isOwnSessionClose(sessionId)");
    expect(rules).toContain("match /sessions/{sessionId}");
    expect(rules).toContain("allow read: if canReadSession();");
    expect(rules).toContain("allow create: if isOwnSessionCreate(sessionId);");
    expect(rules).toContain("allow update: if isOwnSessionClose(sessionId);");
    expect(rules).not.toContain("allow read, update: if ownsSession(sessionId);");
    expect(rules).not.toContain("match /{document=**}");
    expect(rules).toContain("match /chat/{messageId}");
    expect(rules).toContain("match /clipboard/{clipboardId}");
    expect(rules).toContain("match /files/{fileId}");
    expect(rules).toContain("match /tileFrames/{frameId}");
    expect(rules).toContain("match /fileReceipts/{transferId}");
    expect(rules).toContain("match /webrtc/{signalId}");
    expect(rules).toContain("match /viewerCandidates/{candidateId}");
    expect(rules).toContain("match /agentCandidates/{candidateId}");
  });

  it("deploys Firebase Storage rules for authenticated session file payloads", () => {
    const firebaseConfig = JSON.parse(readFileSync(resolve(repoRoot, "firebase.json"), "utf8")) as {
      storage?: { rules?: string };
    };
    const storageRules = readFileSync(resolve(repoRoot, "storage.rules"), "utf8");

    expect(firebaseConfig.storage?.rules).toBe("storage.rules");
    expect(storageRules).toContain("service firebase.storage");
    expect(storageRules).toContain("match /sessions/{sessionId}/files/{transferId}/{fileName}");
    expect(storageRules).toContain("request.auth != null");
    expect(storageRules).toContain("firestore.get(/databases/(default)/documents/sessions/$(sessionId)).data.ownerUid == request.auth.uid");
    expect(storageRules).toContain("request.resource.size <= 500 * 1024 * 1024");
    expect(storageRules).toContain("allow delete: if ownsSession(sessionId);");
  });

  it("limits Firestore file queue writes to Storage metadata or tiny direct fallback payloads", () => {
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");

    expect(rules).toContain("function isOwnSessionFileCreate(sessionId)");
    expect(rules).toContain('request.resource.data.delivery == "firebase-storage"');
    expect(rules).toContain('request.resource.data.fileData == ""');
    expect(rules).toContain("request.resource.data.storagePath is string");
    expect(rules).toContain("request.resource.data.keys().hasOnly");
    expect(rules).not.toContain("downloadUrl");
    expect(rules).toContain('request.resource.data.delivery == "firestore-direct"');
    expect(rules).toContain("request.resource.data.fileData.size() <= 128 * 1024");
    expect(rules).toContain("allow create: if isOwnSessionFileCreate(sessionId);");
  });

  it("allows secure challenges only for the authenticated owner in Spark fallback mode", () => {
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");

    expect(rules).toContain("match /secureChallenges/{challengeId}");
    expect(rules).toContain("function isOwnSecureChallengeCreate()");
    expect(rules).toContain("function isOwnSecureChallengeUpdate()");
    expect(rules).toContain("allow create: if isOwnSecureChallengeCreate();");
    expect(rules).toContain("allow read: if ownsSecureChallenge();");
    expect(rules).toContain("allow update: if isOwnSecureChallengeUpdate();");
    expect(rules).toContain("allow delete: if false;");
  });

  it("queues remote input through a connected session instead of a raw device id", () => {
    const functionsSource = readFileSync(resolve(repoRoot, "functions/src/index.ts"), "utf8");
    const start = functionsSource.indexOf("export const enqueueCommand");
    const end = functionsSource.indexOf("export const closeSession");
    const enqueueCommandBlock = functionsSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(enqueueCommandBlock).toContain('requireString(request.data?.sessionId, "sessionId")');
    expect(enqueueCommandBlock).toContain("readOwnedConnectedSession(transaction, sessionId, uid)");
    expect(enqueueCommandBlock).toContain("db.runTransaction");
    expect(enqueueCommandBlock).not.toContain("request.data?.deviceId");
  });

  it("creates a unique Firebase session and targets start/stop commands to that session", () => {
    const functionsSource = readFileSync(resolve(repoRoot, "functions/src/index.ts"), "utf8");

    expect(functionsSource).toContain('const sessionRef = db.collection("sessions").doc();');
    expect(functionsSource).toContain('action: `start-stream ${session.id}`');
    expect(functionsSource).toContain('action: `stop-stream ${sessionId}`');
    expect(functionsSource).not.toContain("firebaseSessionIdForDevice");
  });

  it("queues Wake-on-LAN only through an owned, recent, same-business relay Agent", () => {
    const functionsSource = readFileSync(resolve(repoRoot, "functions/src/index.ts"), "utf8");
    const rules = readFileSync(resolve(repoRoot, "firestore.rules"), "utf8");
    const start = functionsSource.indexOf("export const wakeDevice");
    const end = functionsSource.indexOf("interface SessionResponse");
    const wakeBlock = functionsSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(wakeBlock).toContain("readOwnedDevice(targetDeviceId, uid)");
    expect(wakeBlock).toContain('where("ownerUid", "==", uid)');
    expect(wakeBlock).toContain("selectWakeRelay");
    expect(wakeBlock).toContain('action: `wake-on-lan ${targetMac}`');
    expect(rules).toContain("allow create: if isOwnDeviceCommandCreate(deviceId);");
  });

  it("lets Agent recovery query owned sessions without making recovery failures fatal", () => {
    const agentEntry = readFileSync(resolve(repoRoot, "aether-link-app/src/agent/index.ts"), "utf8");
    const agentFirebase = readFileSync(resolve(repoRoot, "aether-link-app/src/firebase/agentFirebase.ts"), "utf8");

    expect(agentEntry).toContain("ensureActiveFirebaseSessionRecovery");
    expect(agentEntry).toContain("activeSessionRecoveryPermissionBlocked");
    expect(agentEntry).toContain("warnActiveSessionRecoveryOnce");
    expect(agentEntry).not.toContain("withAgentOperationContext(\"firebase active session recovery\"");
    expect(agentFirebase).toContain("fetchActiveFirebaseSessionsForAgent");
    expect(agentFirebase).toContain('where("deviceId", "==", input.deviceId)');
    expect(agentFirebase).not.toContain('where("ownerUid", "==", userId)');
    expect(agentFirebase).toContain('where("state", "==", "connected")');
    expect(agentFirebase).toContain(".sort((left, right) => sessionStartedAtMs(right.data) - sessionStartedAtMs(left.data))");
    expect(agentFirebase).toContain(".slice(0, 1)");
  });

  it("normalizes Firebase device metadata store names before writing to Firestore", () => {
    const source = readFileSync(resolve(repoRoot, "aether-link-app/src/firebase/viewerFirebase.ts"), "utf8");
    const start = source.indexOf("export async function updateFirebaseDeviceMetadata");
    const end = source.indexOf("export async function registerFirstRunAgentWithFirebase");
    const block = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain("normalizeStoreNameForDisplay(input.storeName, currentDevice.businessNumber)");
    expect(block).toContain('update.storeNameSource = storeName === DEFAULT_STORE_NAME ? "default" : "user"');
  });
});
