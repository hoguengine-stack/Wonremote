import type { AgentDataChannelLike } from "../firebase/agentPeerConnection";
import type { WebRtcFileAckMessage } from "../domain/webrtcFileTransfer";
import { sendLocalFile, type LocalFileSendOptions } from "./webrtcFileSender";

export type AgentFileSendInput = Pick<LocalFileSendOptions, "sourcePath" | "transferId" | "signal" | "onProgress">;

export function createFileChannelSender(channel: AgentDataChannelLike) {
  let closed = false;
  let active: { id: string; controller: AbortController; ack?: WebRtcFileAckMessage } | undefined;
  let notify: ((ack: WebRtcFileAckMessage) => void) | undefined;
  return {
    acknowledge(ack: WebRtcFileAckMessage) {
      if (closed || !active || active.id !== ack.transferId) return;
      active.ack = ack;
      notify?.(ack);
    },
    close() {
      closed = true;
      active?.controller.abort();
    },
    async sendFile(input: AgentFileSendInput): Promise<void> {
      if (closed || channel.readyState !== "open" || !channel.send) throw new Error("File channel is unavailable.");
      if (active) throw new Error("A file transfer is already active.");
      const operation = { id: input.transferId, controller: new AbortController(), ack: undefined as WebRtcFileAckMessage | undefined };
      active = operation;
      const abort = () => operation.controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      try {
        await sendLocalFile({ ...input, signal: operation.controller.signal,
          send(payload) {
            if (closed || channel.readyState !== "open" || !channel.send) throw new Error("File channel closed during transfer.");
            channel.send(payload);
          },
          waitForAck(_id, chunks, signal) {
            const ready = (ack: WebRtcFileAckMessage) => ack.status === "error" || ack.status === "complete" || ack.receivedChunks >= chunks;
            if (operation.ack && ready(operation.ack)) return Promise.resolve(operation.ack);
            return new Promise((resolve, reject) => {
              const cleanup = () => { notify = undefined; signal.removeEventListener("abort", cancelled); };
              const cancelled = () => { cleanup(); reject(new DOMException("File transfer cancelled.", "AbortError")); };
              notify = ack => { if (ready(ack)) { cleanup(); resolve(ack); } };
              signal.addEventListener("abort", cancelled, { once: true });
              if (signal.aborted) cancelled();
            });
          },
        });
      } finally {
        input.signal?.removeEventListener("abort", abort);
        operation.controller.abort();
        notify = undefined;
        active = undefined;
      }
    },
  };
}
