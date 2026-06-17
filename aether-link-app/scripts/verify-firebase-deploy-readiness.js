import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");

export function verifyFirebaseDeployReadiness(root = repoRoot) {
  const failures = [];
  const firebaseJson = readJson(path.join(root, "firebase.json"), failures);
  const firestoreRules = readText(path.join(root, "firestore.rules"), failures);
  const storageRules = readText(path.join(root, "storage.rules"), failures);
  const deployScript = readText(path.join(root, "aether-link-app", "scripts", "deploy-firebase.ps1"), failures);
  const realtimePolicy = readText(path.join(root, "aether-link-app", "src", "domain", "realtimeTransportPolicy.ts"), failures);
  const agentSource = readText(path.join(root, "aether-link-app", "src", "agent", "index.ts"), failures);
  const viewerSource = readText(path.join(root, "aether-link-app", "src", "App.tsx"), failures);

  if (firebaseJson) {
    expectEqual(firebaseJson.firestore?.rules, "firestore.rules", "firebase.json must point to firestore.rules", failures);
    expectEqual(firebaseJson.storage?.rules, "storage.rules", "firebase.json must point to storage.rules", failures);
    expectEqual(firebaseJson.hosting?.public, "aether-link-app/dist", "firebase.json must deploy the Vite dist folder", failures);
    if (!firebaseJson.functions?.source) {
      failures.push("firebase.json must include a Cloud Functions source for server-side validation.");
    }
  }

  expectContains(firestoreRules, "match /devices/{deviceId}", "firestore.rules must protect devices.", failures);
  expectContains(firestoreRules, "match /sessions/{sessionId}", "firestore.rules must protect sessions.", failures);
  expectContains(firestoreRules, "match /commands/{commandId}", "firestore.rules must protect command queues.", failures);
  expectContains(firestoreRules, "match /viewerCandidates/{candidateId}", "firestore.rules must protect WebRTC viewer candidates.", failures);
  expectContains(firestoreRules, "match /agentCandidates/{candidateId}", "firestore.rules must protect WebRTC agent candidates.", failures);
  rejectContains(firestoreRules, "allow read, write: if true", "firestore.rules must not allow blanket read/write.", failures);
  rejectContains(firestoreRules, "match /{document=**}", "firestore.rules must not rely on recursive wildcard access.", failures);

  expectContains(storageRules, "service firebase.storage", "storage.rules must define Firebase Storage rules.", failures);
  expectContains(storageRules, "request.resource.size <= 500 * 1024 * 1024", "storage.rules must keep the 500MB cap.", failures);
  rejectContains(storageRules, "allow read, write: if true", "storage.rules must not allow blanket read/write.", failures);

  expectContains(deployScript, "WONREMOTE_FIREBASE_DEPLOY_APPROVED", "deploy script must require the explicit deploy gate.", failures);
  expectContains(deployScript, "firestore:rules,storage,hosting", "deploy script must include Storage rules in Spark deploys.", failures);
  expectContains(deployScript, "functions,firestore:rules,storage,hosting", "deploy script must include Functions in full deploys.", failures);
  expectContains(deployScript, "Skipping Firebase Storage rules deploy", "deploy script must warn when Storage is skipped.", failures);

  expectContains(realtimePolicy, 'value?.trim().toLowerCase() === "diagnostic"', "Viewer Firestore tile fallback must be diagnostic-only.", failures);
  expectContains(agentSource, "WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK=diagnostic", "Agent must document diagnostic-only Firestore tile fallback.", failures);
  expectContains(viewerSource, "diagnostic-fallback-polling", "Viewer must label diagnostic fallback polling explicitly.", failures);
  expectContains(viewerSource, "webrtc-unavailable", "Viewer must surface WebRTC unavailable states.", failures);

  return failures;
}

function readJson(filePath, failures) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    failures.push(`${filePath} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readText(filePath, failures) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    failures.push(`${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function expectEqual(actual, expected, message, failures) {
  if (actual !== expected) {
    failures.push(`${message} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function expectContains(source, needle, message, failures) {
  if (!source.includes(needle)) {
    failures.push(`${message} Missing ${JSON.stringify(needle)}.`);
  }
}

function rejectContains(source, needle, message, failures) {
  if (source.includes(needle)) {
    failures.push(`${message} Found forbidden ${JSON.stringify(needle)}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = verifyFirebaseDeployReadiness(repoRoot);
  if (failures.length > 0) {
    console.error("Firebase deploy readiness failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
  console.log("Firebase deploy readiness OK.");
}
