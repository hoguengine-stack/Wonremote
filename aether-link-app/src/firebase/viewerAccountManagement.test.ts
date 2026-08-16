import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIdTokenResult } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import {
  createViewerAccount,
  deleteViewerAccount,
  isCurrentViewerAccountManager,
  listViewerAccounts,
  updateViewerAccount,
} from "./viewerFirebase";

const state = vi.hoisted(() => ({
  user: { uid: "Xjjdvk0Nx1eqCvND4yIOHbM53tl1" },
  callable: vi.fn(),
}));

vi.mock("./firebaseConfig", () => ({
  resolveFirebaseConfig: vi.fn(() => ({ apiKey: "key", appId: "app", authDomain: "test", projectId: "test" })),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => ({ auth: { currentUser: state.user }, db: {}, functions: {} })),
}));

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/auth")>()),
  getIdTokenResult: vi.fn(async () => ({ claims: {} })),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: vi.fn(() => state.callable),
}));

describe("Viewer account management client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { uid: "Xjjdvk0Nx1eqCvND4yIOHbM53tl1" };
    state.callable.mockResolvedValue({ data: [] });
  });

  it("recognizes the bootstrap account manager without requiring a claim", async () => {
    await expect(isCurrentViewerAccountManager()).resolves.toBe(true);
    expect(getIdTokenResult).not.toHaveBeenCalled();
  });

  it("calls only the dedicated account-management functions", async () => {
    await listViewerAccounts();
    expect(httpsCallable).toHaveBeenLastCalledWith({}, "listViewerAccounts");

    state.callable.mockResolvedValue({ data: { uid: "viewer-1" } });
    await createViewerAccount({ email: "staff@example.com", password: "password8" });
    expect(httpsCallable).toHaveBeenLastCalledWith({}, "createViewerAccount");

    await updateViewerAccount({ uid: "viewer-1", disabled: true });
    expect(httpsCallable).toHaveBeenLastCalledWith({}, "updateViewerAccount");

    await deleteViewerAccount("viewer-1");
    expect(httpsCallable).toHaveBeenLastCalledWith({}, "deleteViewerAccount");
  });
});
