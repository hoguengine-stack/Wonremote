import { describe, expect, it } from "vitest";
import {
  computeVisualPingLatencyMs,
  getAdaptiveStreamSleepCommand,
  isVisualPingMarkerPixel,
  scheduleVisualPingPresentedMeasurement,
} from "./visualPing";

describe("visual ping telemetry", () => {
  it("detects the magenta marker after JPEG compression tolerance", () => {
    expect(isVisualPingMarkerPixel({ r: 255, g: 0, b: 255 })).toBe(true);
    expect(isVisualPingMarkerPixel({ r: 224, g: 32, b: 232 })).toBe(true);
    expect(isVisualPingMarkerPixel({ r: 240, g: 20, b: 20 })).toBe(false);
  });

  it("measures presented latency from the original ping start timestamp", () => {
    expect(computeVisualPingLatencyMs({ startedAtMs: 1000, presentedAtMs: 1133.4 })).toBeCloseTo(133.4);
    expect(computeVisualPingLatencyMs({ startedAtMs: 1000, presentedAtMs: 999 })).toBe(0);
  });

  it("selects conservative stream pacing only after the latency threshold is crossed", () => {
    expect(getAdaptiveStreamSleepCommand(150)).toBe("set-sleep 33");
    expect(getAdaptiveStreamSleepCommand(150.1)).toBe("set-sleep 100");
  });

  it("waits for a completed paint boundary before sampling the presented marker", () => {
    const frameCallbacks: Array<() => void> = [];
    let sampled = false;
    let result: { latencyMs: number; sleepCommand: string } | undefined;

    scheduleVisualPingPresentedMeasurement({
      startedAtMs: 1000,
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
      },
      readPixel: () => {
        sampled = true;
        return { r: 255, g: 0, b: 255 };
      },
      nowMs: () => 1120,
      onPresented: (measurement) => {
        result = measurement;
      },
    });

    expect(sampled).toBe(false);
    expect(result).toBeUndefined();

    frameCallbacks.shift()?.();

    expect(sampled).toBe(false);
    expect(result).toBeUndefined();

    frameCallbacks.shift()?.();

    expect(sampled).toBe(true);
    expect(result).toEqual({ latencyMs: 120, sleepCommand: "set-sleep 33" });
  });

  it("ignores a rendered frame that does not contain the visual ping marker", () => {
    let result: { latencyMs: number; sleepCommand: string } | undefined;

    scheduleVisualPingPresentedMeasurement({
      startedAtMs: 1000,
      requestAnimationFrame: (callback) => callback(),
      readPixel: () => ({ r: 40, g: 40, b: 40 }),
      nowMs: () => 1120,
      onPresented: (measurement) => {
        result = measurement;
      },
    });

    expect(result).toBeUndefined();
  });
});
