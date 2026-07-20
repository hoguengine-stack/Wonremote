import { describe, expect, it } from "vitest";
import {
  buildSetStreamModeCommand,
  getStreamPerformanceProfile,
  normalizeStreamPerformanceMode,
  parseSetStreamModeCommand,
  type StreamPerformanceMode,
} from "./streamPerformanceMode";

describe("stream performance mode", () => {
  it("defaults unknown values to normal", () => {
    expect(normalizeStreamPerformanceMode(undefined)).toBe("normal");
    expect(normalizeStreamPerformanceMode(" FAST ")).toBe("fast");
    expect(normalizeStreamPerformanceMode("turbo")).toBe("normal");
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
    const modes: StreamPerformanceMode[] = ["fast", "normal"];
    for (const mode of modes) {
      expect(parseSetStreamModeCommand(buildSetStreamModeCommand(mode))).toBe(mode);
    }
    expect(parseSetStreamModeCommand("set-stream-mode fast extra")).toBeNull();
    expect(parseSetStreamModeCommand("set-stream-mode turbo")).toBeNull();
  });
});
