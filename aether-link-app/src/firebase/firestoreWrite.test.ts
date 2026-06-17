import { describe, expect, it, vi } from "vitest";
import { addDoc, setDoc, updateDoc } from "firebase/firestore";
import { safeAddDoc, safeBatchUpdate, safeSetDoc, safeUpdateDoc } from "./firestoreWrite";

vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(async () => ({ id: "doc-1" })),
  setDoc: vi.fn(async () => undefined),
  updateDoc: vi.fn(async () => undefined),
}));

describe("safe Firestore writes", () => {
  it("strips undefined values before setDoc", async () => {
    await safeSetDoc(
      { path: "devices/device-1" } as any,
      {
        nested: {
          keep: true,
          skip: undefined,
        },
        version: undefined,
      },
      { merge: true },
    );

    expect(setDoc).toHaveBeenCalledWith(
      { path: "devices/device-1" },
      { nested: { keep: true } },
      { merge: true },
    );
  });

  it("strips undefined values before updateDoc", async () => {
    await safeUpdateDoc({ path: "devices/device-1" } as any, {
      displayIndex: 0,
      version: undefined,
    });

    expect(updateDoc).toHaveBeenCalledWith({ path: "devices/device-1" }, { displayIndex: 0 });
  });

  it("strips undefined values before addDoc", async () => {
    await safeAddDoc({ path: "sessions/session-1/chat" } as any, {
      message: "ok",
      optional: undefined,
    });

    expect(addDoc).toHaveBeenCalledWith({ path: "sessions/session-1/chat" }, { message: "ok" });
  });

  it("strips undefined values before batch.update", () => {
    const batch = { update: vi.fn() };

    safeBatchUpdate(batch as any, { path: "commands/command-1" } as any, {
      deliveredAt: "server-time",
      optional: undefined,
      state: "delivered",
    });

    expect(batch.update).toHaveBeenCalledWith(
      { path: "commands/command-1" },
      { deliveredAt: "server-time", state: "delivered" },
    );
  });
});
