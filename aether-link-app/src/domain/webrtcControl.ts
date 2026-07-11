export const WEBRTC_CONTROL_CHANNEL_LABEL = "wonremote-control";
export const WEBRTC_TILE_CHANNEL_LABEL = "wonremote-tiles";
export const MAX_WEBRTC_CONTROL_ACTION_BYTES = 16 * 1024;

export type WebRtcControlMessage = {
  type: "control";
  action: string;
};

export function serializeWebRtcControlAction(action: string): string {
  if (!action || action.includes("\0")) {
    throw new Error("WebRTC control action is invalid.");
  }
  const payload = JSON.stringify({ type: "control", action } satisfies WebRtcControlMessage);
  if (new TextEncoder().encode(payload).byteLength > MAX_WEBRTC_CONTROL_ACTION_BYTES) {
    throw new Error("WebRTC control action is too large.");
  }
  return payload;
}

export function parseWebRtcControlAction(payload: unknown): string | null {
  if (typeof payload !== "string") {
    return null;
  }
  if (new TextEncoder().encode(payload).byteLength > MAX_WEBRTC_CONTROL_ACTION_BYTES) {
    return null;
  }
  try {
    const message = JSON.parse(payload) as Partial<WebRtcControlMessage>;
    return message.type === "control" && typeof message.action === "string" && message.action && !message.action.includes("\0")
      ? message.action
      : null;
  } catch {
    return null;
  }
}
