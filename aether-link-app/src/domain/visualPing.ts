export type VisualPingPixel = {
  r: number;
  g: number;
  b: number;
};

export type VisualPingLatencyInput = {
  startedAtMs: number;
  presentedAtMs: number;
};

export type VisualPingMeasurement = {
  latencyMs: number;
  sleepCommand: "set-sleep 33" | "set-sleep 100";
};

export type ScheduleVisualPingPresentedMeasurementInput = {
  startedAtMs: number;
  requestAnimationFrame: (callback: () => void) => void;
  readPixel: () => VisualPingPixel;
  nowMs: () => number;
  onPresented: (measurement: VisualPingMeasurement) => void;
};

export function isVisualPingMarkerPixel(pixel: VisualPingPixel): boolean {
  return pixel.r >= 200 && pixel.g <= 50 && pixel.b >= 200;
}

export function computeVisualPingLatencyMs(input: VisualPingLatencyInput): number {
  return Math.max(0, input.presentedAtMs - input.startedAtMs);
}

export function getAdaptiveStreamSleepCommand(latencyMs: number): "set-sleep 33" | "set-sleep 100" {
  return latencyMs > 150 ? "set-sleep 100" : "set-sleep 33";
}

export function scheduleVisualPingPresentedMeasurement(input: ScheduleVisualPingPresentedMeasurementInput): void {
  input.requestAnimationFrame(() => {
    let pixel: VisualPingPixel;
    try {
      pixel = input.readPixel();
    } catch {
      return;
    }

    if (!isVisualPingMarkerPixel(pixel)) {
      return;
    }

    const latencyMs = computeVisualPingLatencyMs({
      startedAtMs: input.startedAtMs,
      presentedAtMs: input.nowMs(),
    });
    input.onPresented({
      latencyMs,
      sleepCommand: getAdaptiveStreamSleepCommand(latencyMs),
    });
  });
}
