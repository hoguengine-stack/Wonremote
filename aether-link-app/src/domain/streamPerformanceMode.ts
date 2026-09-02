export type StreamPerformanceMode = "auto" | "fast" | "normal";

export interface StreamPerformanceProfile {
  readonly loopSleepMs: number;
  readonly jpegQuality: number;
  readonly maxMergeWidth: number;
  readonly maxBufferedAmount: number;
}

const PROFILES: Readonly<Record<StreamPerformanceMode, StreamPerformanceProfile>> = Object.freeze({
  auto: Object.freeze({
    loopSleepMs: 25,
    jpegQuality: 78,
    maxMergeWidth: 384,
    maxBufferedAmount: 1024 * 1024,
  }),
  fast: Object.freeze({
    loopSleepMs: 16,
    jpegQuality: 75,
    maxMergeWidth: 512,
    maxBufferedAmount: 512 * 1024,
  }),
  normal: Object.freeze({
    loopSleepMs: 33,
    jpegQuality: 85,
    maxMergeWidth: 256,
    maxBufferedAmount: 2 * 1024 * 1024,
  }),
});

export function normalizeStreamPerformanceMode(value: unknown): StreamPerformanceMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "fast" || normalized === "normal" ? normalized : "auto";
}

export function getStreamPerformanceProfile(mode: unknown = "auto"): StreamPerformanceProfile {
  return PROFILES[normalizeStreamPerformanceMode(mode)];
}

export function buildSetStreamModeCommand(mode: StreamPerformanceMode): string {
  return `set-stream-mode ${mode}`;
}

export function parseSetStreamModeCommand(action: string): StreamPerformanceMode | null {
  const match = /^set-stream-mode\s+(auto|fast|normal)$/.exec(action.trim().toLowerCase());
  return match ? match[1] as StreamPerformanceMode : null;
}

export function getAdaptiveStreamPerformanceProfile(input: {
  backpressured: boolean;
  bufferedAmount: number;
  droppedFrames: number;
}): StreamPerformanceProfile {
  if (input.backpressured || input.bufferedAmount >= 1024 * 1024 || input.droppedFrames >= 3) {
    return { loopSleepMs: 66, jpegQuality: 60, maxMergeWidth: 128, maxBufferedAmount: 2 * 1024 * 1024 };
  }
  if (input.bufferedAmount >= 256 * 1024 || input.droppedFrames > 0) {
    return { loopSleepMs: 40, jpegQuality: 68, maxMergeWidth: 192, maxBufferedAmount: 1536 * 1024 };
  }
  return { loopSleepMs: 20, jpegQuality: 76, maxMergeWidth: 384, maxBufferedAmount: 1024 * 1024 };
}
