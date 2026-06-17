import { describe, expect, it } from "vitest";
import { shouldPollViewerTileFallback } from "./realtimeTransportPolicy";

describe("realtime transport policy", () => {
  it("keeps local API tile polling available outside Firebase mode", () => {
    expect(shouldPollViewerTileFallback({ firebaseEnabled: false, env: {} })).toBe(true);
  });

  it("blocks Firestore tile polling in Firebase production mode", () => {
    expect(shouldPollViewerTileFallback({ firebaseEnabled: true, env: {} })).toBe(false);
    expect(
      shouldPollViewerTileFallback({
        firebaseEnabled: true,
        env: { VITE_WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK: "true" },
      }),
    ).toBe(false);
  });

  it("allows Firestore tile polling only for explicit diagnostics", () => {
    expect(
      shouldPollViewerTileFallback({
        firebaseEnabled: true,
        env: { VITE_WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK: "diagnostic" },
      }),
    ).toBe(true);
  });
});
