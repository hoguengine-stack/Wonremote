import type { FirebaseOptions } from "firebase/app";

export const PUBLIC_WONREMOTE_FIREBASE_CONFIG: Required<
  Pick<FirebaseOptions, "apiKey" | "authDomain" | "projectId" | "appId">
> &
  Pick<FirebaseOptions, "storageBucket" | "messagingSenderId"> = {
  apiKey: "AIzaSyDb1Ihymmrt1SSYvbOAB2NjRV9PiWMY2y8",
  authDomain: "wonremote-a7fd3.firebaseapp.com",
  projectId: "wonremote-a7fd3",
  appId: "1:52940136204:web:b4b4ff3e57c215e5dc3329",
  storageBucket: "wonremote-a7fd3.appspot.com",
  messagingSenderId: "52940136204",
};
