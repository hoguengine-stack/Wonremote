import { describe, expect, it } from "vitest";
import { isFirebaseConfigured, resolveFirebaseConfig } from "./firebaseConfig";

describe("firebase config resolution", () => {
  it("uses the public WonRemote Firebase config when env values are absent", () => {
    expect(resolveFirebaseConfig({})).toMatchObject({
      apiKey: "AIzaSyDb1Ihymmrt1SSYvbOAB2NjRV9PiWMY2y8",
      authDomain: "wonremote-a7fd3.firebaseapp.com",
      projectId: "wonremote-a7fd3",
      appId: "1:52940136204:web:b4b4ff3e57c215e5dc3329",
    });
    expect(isFirebaseConfigured({})).toBe(true);
  });

  it("can explicitly disable Firebase for local API tests", () => {
    expect(resolveFirebaseConfig({ WONREMOTE_DISABLE_FIREBASE: "1" })).toBeNull();
    expect(isFirebaseConfigured({ VITE_WONREMOTE_DISABLE_FIREBASE: "true" })).toBe(false);
  });

  it("reads browser Vite Firebase config", () => {
    const config = resolveFirebaseConfig({
      VITE_WONREMOTE_FIREBASE_API_KEY: "api-key",
      VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN: "project.firebaseapp.com",
      VITE_WONREMOTE_FIREBASE_PROJECT_ID: "project-id",
      VITE_WONREMOTE_FIREBASE_APP_ID: "app-id",
    });

    expect(config).toMatchObject({
      apiKey: "api-key",
      authDomain: "project.firebaseapp.com",
      projectId: "project-id",
      appId: "app-id",
    });
    expect(isFirebaseConfigured({
      VITE_WONREMOTE_FIREBASE_API_KEY: "api-key",
      VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN: "project.firebaseapp.com",
      VITE_WONREMOTE_FIREBASE_PROJECT_ID: "project-id",
      VITE_WONREMOTE_FIREBASE_APP_ID: "app-id",
    })).toBe(true);
  });

  it("reads Node runtime Firebase config without the Vite prefix", () => {
    const config = resolveFirebaseConfig({
      WONREMOTE_FIREBASE_API_KEY: "api-key",
      WONREMOTE_FIREBASE_AUTH_DOMAIN: "project.firebaseapp.com",
      WONREMOTE_FIREBASE_PROJECT_ID: "project-id",
      WONREMOTE_FIREBASE_APP_ID: "app-id",
      WONREMOTE_FIREBASE_STORAGE_BUCKET: "project.appspot.com",
      WONREMOTE_FIREBASE_MESSAGING_SENDER_ID: "sender-id",
    });

    expect(config).toMatchObject({
      apiKey: "api-key",
      authDomain: "project.firebaseapp.com",
      projectId: "project-id",
      appId: "app-id",
      storageBucket: "project.appspot.com",
      messagingSenderId: "sender-id",
    });
  });
});
