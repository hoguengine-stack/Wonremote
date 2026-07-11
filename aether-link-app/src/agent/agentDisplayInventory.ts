import type { DeviceDisplayInfo } from "../domain/types";

export function parseAgentDisplayInventory(input: unknown): DeviceDisplayInfo[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((display): display is Record<string, unknown> => {
      return (
        typeof display === "object" &&
        display !== null &&
        Number.isFinite(Number((display as Record<string, unknown>).index)) &&
        Number((display as Record<string, unknown>).width) > 0 &&
        Number((display as Record<string, unknown>).height) > 0
      );
    })
    .map((display) => {
      const x = Number(display.x);
      const y = Number(display.y);
      return {
        index: Number(display.index),
        name: String(display.name ?? `Display ${display.index}`),
        ...(Number.isFinite(x) ? { x } : {}),
        ...(Number.isFinite(y) ? { y } : {}),
        width: Number(display.width),
        height: Number(display.height),
        primary: Boolean(display.primary),
      };
    });
}
