export type AgentDataChannelState = "open" | "closed" | "error";

export interface AgentDataChannelLike {
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
}

export function bindAgentDataChannelStatus(
  channel: AgentDataChannelLike,
  handlers: { onState?: (state: AgentDataChannelState, error?: string) => void },
): void {
  channel.onopen = () => {
    console.log("[WebRTC] Agent data channel state: open");
    handlers.onState?.("open");
  };
  channel.onclose = () => {
    console.log("[WebRTC] Agent data channel state: closed");
    handlers.onState?.("closed");
  };
  channel.onerror = () => {
    const message = "Agent WebRTC data channel failed.";
    console.warn("[WebRTC] Agent data channel error.");
    handlers.onState?.("error", message);
  };
}

export function formatNodeDataChannelUnavailableError(error: unknown, arch: string = process.arch): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (arch === "ia32" || arch === "x86") {
    return `32-bit WebRTC native module unavailable; realtime tile channel cannot start: ${detail}`;
  }
  return `node-datachannel unavailable; realtime tile channel cannot start: ${detail}`;
}
