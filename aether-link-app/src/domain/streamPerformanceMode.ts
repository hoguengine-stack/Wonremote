export type StreamPerformanceMode = "fast" | "normal";

export interface StreamPerformanceProfile {
  readonly loopSleepMs: number;
  readonly jpegQuality: number;
  readonly maxMergeWidth: number;
  readonly maxBufferedAmount: number;
}

const PROFILES: Readonly<Record<StreamPerformanceMode, StreamPerformanceProfile>> = Object.freeze({
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
  return typeof value === "string" && value.trim().toLowerCase() === "fast" ? "fast" : "normal";
}

export function getStreamPerformanceProfile(mode: unknown = "normal"): StreamPerformanceProfile {
  return PROFILES[normalizeStreamPerformanceMode(mode)];
}

export function buildSetStreamModeCommand(mode: StreamPerformanceMode): string {
  return `set-stream-mode ${mode}`;
}

export function parseSetStreamModeCommand(action: string): StreamPerformanceMode | null {
  const match = /^set-stream-mode\s+(fast|normal)$/.exec(action.trim().toLowerCase());
  return match ? match[1] as StreamPerformanceMode : null;
}
