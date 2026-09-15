import { beforeEach, expect, it, vi } from "vitest";
import { requestFirebaseAgentRollback } from "./viewerFirebase";
const state = vi.hoisted(() => ({
  device: { version: "0.2.0", rollbackSupportVersion: "0.2.0", platform: "windows" },
  user: { uid: "Xjjdvk0Nx1eqCvND4yIOHbM53tl1" },
  read: vi.fn(), update: vi.fn(), set: vi.fn(), commit: vi.fn(),
}));
vi.mock("./firebaseConfig", () => ({ resolveFirebaseConfig: () => ({ apiKey: "key", appId: "app", authDomain: "test", projectId: "test" }) }));
vi.mock("./firebaseServices", () => ({ getWonRemoteFirebaseServices: () => ({ auth: { currentUser: state.user }, db: {}, functions: {} }) }));
vi.mock("firebase/auth", async original => ({ ...await original<typeof import("firebase/auth")>(), getIdTokenResult: async () => ({ claims: {} }) }));
vi.mock("firebase/firestore", async original => ({
  ...await original<typeof import("firebase/firestore")>(),
  doc: (_db: unknown, ...parts: string[]) => ({ path: parts.join("/") || "new-command" }),
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join("/") }),
  getDocFromServer: (...args: unknown[]) => state.read(...args),
  serverTimestamp: () => "server-time",
  writeBatch: () => ({ update: state.update, set: state.set, commit: state.commit }),
}));
beforeEach(() => {
  vi.clearAllMocks(); state.user.uid = "Xjjdvk0Nx1eqCvND4yIOHbM53tl1";
  state.device = { version: "0.2.0", rollbackSupportVersion: "0.2.0", platform: "windows" };
  state.read.mockImplementation(async () => ({ exists: () => true, data: () => state.device }));
  state.commit.mockResolvedValue(undefined);
});
it("commits pause and rollback command together only for a supported older target", async () => {
  await requestFirebaseAgentRollback("device-1", "0.1.90");
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(state.update).toHaveBeenCalledWith({ path: "devices/device-1" }, { updatePaused: true, updatedAt: "server-time" });
  expect(state.set).toHaveBeenCalledWith({ path: "new-command" }, expect.objectContaining({ action: expect.stringMatching(/^request-rollback 0\.1\.90 \d{13}$/), state: "pending" }));
  expect(state.commit).toHaveBeenCalledTimes(1);
});
it("rejects unsupported capability and unauthorized caller without writes", async () => {
  state.device.rollbackSupportVersion = "0.1.99";
  await expect(requestFirebaseAgentRollback("device-1", "0.1.90")).rejects.toThrow("support");
  expect(state.commit).not.toHaveBeenCalled();
  state.read.mockClear(); state.user.uid = "outsider";
  await expect(requestFirebaseAgentRollback("device-1", "0.1.90")).rejects.toThrow("central Viewer");
  expect(state.read).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
});
it("surfaces atomic commit failure instead of reporting a queued rollback", async () => {
  state.commit.mockRejectedValueOnce(new Error("permission denied"));
  await expect(requestFirebaseAgentRollback("device-1", "0.1.90")).rejects.toThrow("permission denied");
  expect(state.commit).toHaveBeenCalledTimes(1);
});
