import { describe, expect, it } from "vitest";
import {
  buildSetStreamModeCommand,
  getAdaptiveStreamPerformanceProfile,
  getStreamPerformanceProfile,
  normalizeStreamPerformanceMode,
  parseSetStreamModeCommand,
  type StreamPerformanceMode,
} from "./streamPerformanceMode";

describe("stream performance mode", () => {
  it("defaults unknown values to adaptive mode", () => {
    expect(normalizeStreamPerformanceMode(undefined)).toBe("auto");
    expect(normalizeStreamPerformanceMode(" FAST ")).toBe("fast");
    expect(normalizeStreamPerformanceMode("turbo")).toBe("auto");
  });

  it("adapts capture cost to WebRTC pressure without changing the selected mode", () => {
    expect(getAdaptiveStreamPerformanceProfile({ backpressured: false, bufferedAmount: 0, droppedFrames: 0 }))
      .toMatchObject({ loopSleepMs: 20, jpegQuality: 76 });
    expect(getAdaptiveStreamPerformanceProfile({ backpressured: false, bufferedAmount: 300_000, droppedFrames: 1 }))
      .toMatchObject({ loopSleepMs: 40, jpegQuality: 68 });
    expect(getAdaptiveStreamPerformanceProfile({ backpressured: true, bufferedAmount: 0, droppedFrames: 0 }))
      .toMatchObject({ loopSleepMs: 66, jpegQuality: 60 });
  });

  it("exposes readonly fast and normal profiles", () => {
    expect(getStreamPerformanceProfile("fast")).toEqual({
      loopSleepMs: 16,
      jpegQuality: 75,
      maxMergeWidth: 512,
      maxBufferedAmount: 512 * 1024,
    });
    expect(getStreamPerformanceProfile("normal")).toEqual({
      loopSleepMs: 33,
      jpegQuality: 85,
      maxMergeWidth: 256,
      maxBufferedAmount: 2 * 1024 * 1024,
    });
    const profile = getStreamPerformanceProfile("fast");
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("builds and strictly parses mode commands", () => {
    const modes: StreamPerformanceMode[] = ["auto", "fast", "normal"];
    for (const mode of modes) {
      expect(parseSetStreamModeCommand(buildSetStreamModeCommand(mode))).toBe(mode);
    }
    expect(parseSetStreamModeCommand("set-stream-mode fast extra")).toBeNull();
    expect(parseSetStreamModeCommand("set-stream-mode turbo")).toBeNull();
  });
});
