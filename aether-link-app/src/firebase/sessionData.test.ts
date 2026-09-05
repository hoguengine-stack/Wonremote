import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDocs, onSnapshot, writeBatch } from "firebase/firestore";
import { subscribeFirebaseSessionData } from "./sessionData";

const state = vi.hoisted(() => ({ listeners: [] as any[], remove: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, ...path: string[]) => path.join("/"),
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  where: (...args: unknown[]) => args, limit: (n: number) => n, query: (...args: unknown[]) => args,
  getDocs: vi.fn(),
  onSnapshot: vi.fn((query, next, error) => {
    const listener = { query, next, error, close: vi.fn() }; state.listeners.push(listener); return listener.close;
  }),
  writeBatch: vi.fn(() => ({ delete: state.remove, commit: state.commit })),
}));
const change = (id: string, data = {}) => ({ type: "added", doc: { id, ref: id, data: () => ({ sender: "agent", message: id, ...data }) } });
const emit = (index: number, changes: unknown[]) => state.listeners[index].next({ docChanges: () => changes });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("event-driven Firebase session queues", () => {
  beforeEach(() => { state.listeners.length = 0; vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("opens only required queues and performs no polling or writes for 24h idle", async () => {
    const stop = subscribeFirebaseSessionData({} as any, "s", "viewer", vi.fn(), vi.fn(), { clipboard: false });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(state.listeners.map((item) => item.query[0])).toEqual(["sessions/s/chat", "sessions/s/files"]);
    emit(0, []); emit(1, []);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(getDocs).not.toHaveBeenCalled(); expect(writeBatch).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    stop(); await vi.advanceTimersByTimeAsync(86_400_000);
    state.listeners.forEach((item) => expect(item.close).toHaveBeenCalledOnce());
  });

  it("serializes slow deliveries and acknowledges only after processing, without duplicate events", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const received = vi.fn().mockImplementationOnce(() => pending);
    subscribeFirebaseSessionData({} as any, "s", "agent", received, vi.fn());
    emit(0, [change("one")]); emit(0, [change("one"), change("two")]);
    emit(1, [change("clip", { text: "hello" })]);
    await flush(); expect(received).toHaveBeenCalledOnce(); expect(state.commit).not.toHaveBeenCalled();
    finish(); await flush();
    expect(received).toHaveBeenCalledTimes(3);
    expect(received.mock.calls[1][0].messages[0].message).toBe("two");
    expect(received.mock.calls[2][0].clipboards[0].text).toBe("hello");
    expect(state.remove.mock.calls.flat()).toEqual(["one", "two", "clip"]);
  });

  it("stops after quota/handler failure without a timer retry or acknowledgement of failed work", async () => {
    const error = new Error("Quota exceeded."); const onError = vi.fn();
    const received = vi.fn().mockRejectedValue(error);
    subscribeFirebaseSessionData({} as any, "s", "agent", received, onError);
    emit(0, [change("one")]); await flush();
    emit(0, [change("two")]); await vi.advanceTimersByTimeAsync(86_400_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(received).toHaveBeenCalledOnce(); expect(state.commit).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(3);
    state.listeners.forEach((item) => expect(item.close).toHaveBeenCalledOnce());
  });

  it("does not process queued or late items after session shutdown", async () => {
    let finish!: () => void;
    const received = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = subscribeFirebaseSessionData({} as any, "s", "agent", received, vi.fn());
    emit(0, [change("one")]); emit(0, [change("two")]); await flush();
    stop(); finish(); emit(0, [change("late")]); await flush();
    expect(received).toHaveBeenCalledOnce(); expect(state.commit).not.toHaveBeenCalled();
  });

  it("watches only selected receipt documents and detaches on terminal result", async () => {
    const received = vi.fn();
    subscribeFirebaseSessionData({} as any, "s", "viewer", received, vi.fn(), { queues: false, receiptIds: ["transfer-1", "transfer-1"] });
    expect(onSnapshot).toHaveBeenCalledOnce(); expect(state.listeners[0].query).toBe("sessions/s/fileReceipts/transfer-1");
    const emitReceipt = (status: string) => state.listeners[0].next({ id: "transfer-1", exists: () => true, data: () => ({ status }) });
    emitReceipt("partial"); await flush(); emitReceipt("received"); await flush(); emitReceipt("received");
    expect(received).toHaveBeenCalledTimes(2); expect(state.listeners[0].close).toHaveBeenCalledOnce();
    expect(writeBatch).not.toHaveBeenCalled(); expect(getDocs).not.toHaveBeenCalled();
  });
});
