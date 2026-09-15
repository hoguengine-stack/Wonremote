import { getAdaptiveStreamPerformanceProfile, type StreamPerformanceProfile } from "../domain/streamPerformanceMode";

export class AdaptiveCapture {
  private lastAt = -Infinity;
  private lastDropped = 0;
  private peakMs = 0;
  private costMs = 0;

  observe(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000) {
      this.peakMs = Math.max(this.peakMs, value);
    }
  }

  update(now: number, pressure: {backpressured: boolean; bufferedAmount: number; droppedFrames: number},
    current: StreamPerformanceProfile, apply: (profile: StreamPerformanceProfile) => void) {
    if (now-this.lastAt < 2000) return;
    this.lastAt = now;
    this.costMs = Math.max(this.peakMs, this.costMs * 0.8);
    this.peakMs = 0;
    const droppedFrames = Math.max(0, pressure.droppedFrames-this.lastDropped);
    this.lastDropped = pressure.droppedFrames;
    const profile = getAdaptiveStreamPerformanceProfile({...pressure,droppedFrames,processingMs:this.costMs});
    if (profile.loopSleepMs !== current.loopSleepMs || profile.jpegQuality !== current.jpegQuality
      || profile.maxMergeWidth !== current.maxMergeWidth || profile.maxBufferedAmount !== current.maxBufferedAmount) apply(profile);
  }
}
