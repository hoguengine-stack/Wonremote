import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const FIREBASE_APP_NAME = "wonremote";

export interface WonRemoteFirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

export function getWonRemoteFirebaseServices(config: FirebaseOptions): WonRemoteFirebaseServices {
  const app = getApps().some((candidate) => candidate.name === FIREBASE_APP_NAME)
    ? getApp(FIREBASE_APP_NAME)
    : initializeApp(config, FIREBASE_APP_NAME);

  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
  };
}
