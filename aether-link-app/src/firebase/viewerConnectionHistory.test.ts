import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDocs, getDocsFromServer, onSnapshot, where } from "firebase/firestore";
import { fetchFirebaseConnectionHistory, subscribeFirebaseConnectionHistory } from "./viewerFirebase";

const state = vi.hoisted(() => ({
  next: undefined as ((snapshot: any) => void) | undefined,
  error: undefined as ((error: Error) => void) | undefined,
  unsubscribe: vi.fn(),
}));
vi.mock("./firebaseConfig", () => ({ resolveFirebaseConfig: () => ({ projectId: "test" }) }));
vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: () => ({ db: {}, auth: { currentUser: { uid: "viewer-1" } } }),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...path: string[]) => path.join("/")),
  query: vi.fn((...parts: unknown[]) => parts),
  where: vi.fn(), limit: vi.fn(), getDocs: vi.fn(), getDocsFromServer: vi.fn(),
  onSnapshot: vi.fn((_query, next, error) => {
    state.next = next;
    state.error = error;
    return state.unsubscribe;
  }),
}));

describe("Firebase history read budget", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("updates history from one listener without polling for an idle day or after cleanup", () => {
    const onHistory = vi.fn();
    const devices = [{ id: "device-1", storeName: "Store", deviceName: "POS" }] as any;
    const close = subscribeFirebaseConnectionHistory(onHistory, vi.fn(), () => devices);
    state.next?.({ docs: [{ id: "session-1", data: () => ({ deviceId: "device-1", state: "connected", startedAt: "2026-09-04T00:00:00Z" }) }] });
    expect(onHistory.mock.lastCall?.[0][0]).toMatchObject({ id: "session-1", storeName: "Store", status: "success" });
    devices[0].storeName = "Renamed";
    state.next?.({ docs: [{ id: "session-1", data: () => ({ deviceId: "device-1", state: "closed", startedAt: "2026-09-04T00:00:00Z" }) }] });
    expect(onHistory.mock.lastCall?.[0][0]).toMatchObject({ storeName: "Renamed", status: "closed" });
    vi.advanceTimersByTime(86_400_000);
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(getDocs).not.toHaveBeenCalled();
    expect(where).toHaveBeenCalledWith("ownerUid", "==", "viewer-1");
    close();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(86_400_000);
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(getDocs).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports quota errors without an automatic resubscribe loop; manual retry can reconnect", () => {
    const onError = vi.fn();
    const close = subscribeFirebaseConnectionHistory(vi.fn(), onError, () => []);
    const error = Object.assign(new Error("Quota exceeded."), { code: "resource-exhausted" });
    state.error?.(error);
    expect(onError).toHaveBeenCalledWith(error);
    vi.advanceTimersByTime(86_400_000);
    expect(onSnapshot).toHaveBeenCalledOnce();
    close();
    const onHistory = vi.fn();
    subscribeFirebaseConnectionHistory(onHistory, onError, () => []);
    state.next?.({ docs: [] });
    expect(onHistory).toHaveBeenCalledWith([]);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it("fetches history only once per call without rereading loaded devices", async () => {
    vi.mocked(getDocsFromServer).mockResolvedValue({ docs: [{ id: "s", data: () => ({ deviceId: "d", state: "closed", startedAt: "2026-09-05T00:00:00Z" }) }] } as any);
    const entries = await fetchFirebaseConnectionHistory(undefined, [{ id: "d", storeName: "Store", deviceName: "POS" }] as any);
    expect(entries[0]).toMatchObject({ storeName: "Store", status: "closed" });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocsFromServer).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("keeps the UI refresh-only without a history subscription or initial request", () => {
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const section = source.slice(source.indexOf("function ConnectionHistorySection"), source.indexOf("const filteredHistory", source.indexOf("function ConnectionHistorySection")));
    expect(section).not.toContain("subscribeFirebaseConnectionHistory(");
    expect(section).not.toContain("setInterval(");
    expect(section).toContain("if (refreshKey === 0) return;");
    expect(section).toContain("void fetchConnectionHistory(devicesRef.current)");
    expect(section).toContain("}, [refreshKey]);");
  });
});
