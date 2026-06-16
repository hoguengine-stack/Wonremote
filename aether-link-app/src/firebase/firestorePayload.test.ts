import { describe, expect, it } from "vitest";
import { stripUndefinedFields } from "./firestorePayload";

describe("Firestore payload sanitation", () => {
  it("removes undefined values recursively before Firestore writes", () => {
    expect(
      stripUndefinedFields({
        activeDisplayIndex: 0,
        streamDiagnostics: {
          backend: "dxgi",
          desired: true,
          running: false,
          restartCount: 0,
          lastFrameAt: undefined,
          lastError: undefined,
        },
        version: undefined,
      }),
    ).toEqual({
      activeDisplayIndex: 0,
      streamDiagnostics: {
        backend: "dxgi",
        desired: true,
        running: false,
        restartCount: 0,
      },
    });
  });

  it("converts undefined array entries to null because Firestore arrays cannot omit positions", () => {
    expect(stripUndefinedFields({ values: ["a", undefined, { ok: true, skip: undefined }] })).toEqual({
      values: ["a", null, { ok: true }],
    });
  });

  it("preserves non-plain Firestore sentinel-like objects", () => {
    class Sentinel {
      readonly kind = "serverTimestamp";
    }
    const sentinel = new Sentinel();

    expect(stripUndefinedFields({ updatedAt: sentinel, skip: undefined })).toEqual({
      updatedAt: sentinel,
    });
  });
});
