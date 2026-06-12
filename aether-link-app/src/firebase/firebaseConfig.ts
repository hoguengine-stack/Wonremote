import type { FirebaseOptions } from "firebase/app";

type FirebaseEnv = object;

const keyPairs = {
  apiKey: ["VITE_WONREMOTE_FIREBASE_API_KEY", "WONREMOTE_FIREBASE_API_KEY"],
  authDomain: ["VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN", "WONREMOTE_FIREBASE_AUTH_DOMAIN"],
  projectId: ["VITE_WONREMOTE_FIREBASE_PROJECT_ID", "WONREMOTE_FIREBASE_PROJECT_ID"],
  appId: ["VITE_WONREMOTE_FIREBASE_APP_ID", "WONREMOTE_FIREBASE_APP_ID"],
  storageBucket: ["VITE_WONREMOTE_FIREBASE_STORAGE_BUCKET", "WONREMOTE_FIREBASE_STORAGE_BUCKET"],
  messagingSenderId: [
    "VITE_WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
    "WONREMOTE_FIREBASE_MESSAGING_SENDER_ID",
  ],
} as const;

export function resolveFirebaseConfig(env: FirebaseEnv): FirebaseOptions | null {
  const apiKey = readEnv(env, keyPairs.apiKey);
  const authDomain = readEnv(env, keyPairs.authDomain);
  const projectId = readEnv(env, keyPairs.projectId);
  const appId = readEnv(env, keyPairs.appId);

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: readEnv(env, keyPairs.storageBucket),
    messagingSenderId: readEnv(env, keyPairs.messagingSenderId),
  };
}

export function isFirebaseConfigured(env: FirebaseEnv): boolean {
  return resolveFirebaseConfig(env) !== null;
}

function readEnv(env: FirebaseEnv, names: readonly string[]): string | undefined {
  const source = env as Record<string, string | undefined>;
  for (const name of names) {
    const value = source[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
