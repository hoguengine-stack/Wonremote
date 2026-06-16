import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithEmailAndPassword } from "firebase/auth";
import { loginViewerWithFirebase } from "./viewerFirebase";

const mockState = vi.hoisted(() => ({
  services: {
    auth: { app: "auth" },
    db: {},
    functions: {},
  },
}));

vi.mock("./firebaseConfig", () => ({
  resolveFirebaseConfig: vi.fn(() => ({
    apiKey: "api-key",
    appId: "app-id",
    authDomain: "wonremote.test",
    projectId: "wonremote-test",
  })),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => mockState.services),
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: "local",
  createUserWithEmailAndPassword: vi.fn(),
  onAuthStateChanged: vi.fn(),
  setPersistence: vi.fn(async () => undefined),
  signInWithEmailAndPassword: vi.fn(async () => ({ user: { uid: "uid-1" } })),
  signOut: vi.fn(),
}));

describe("Viewer Firebase authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the same business-number Firebase account as the Agent", async () => {
    await loginViewerWithFirebase("123-45-67890", "1234");

    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
      mockState.services.auth,
      "1234567890@agents.wonremote.app",
      "wonremote-1234567890-1234",
    );
  });

  it("keeps email login available for explicit Firebase accounts", async () => {
    await loginViewerWithFirebase("owner@example.com", "secret123");

    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
      mockState.services.auth,
      "owner@example.com",
      "secret123",
    );
  });
});
