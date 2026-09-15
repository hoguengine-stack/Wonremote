import { randomUUID } from "node:crypto";
import { selectFileToSend } from "./selectFileToSend";
import type { AgentFileSendInput } from "./fileChannelSender";
import type { WebRtcFileStatusMessage } from "../domain/webrtcFileTransfer";
import { parseResumeFileRequest } from "../domain/webrtcFileTransfer";

type Context = { key: string; sendFile: (input: AgentFileSendInput) => Promise<void>; sendStatus?: (status: WebRtcFileStatusMessage) => unknown };

export function createReverseFileRequest(options: {
  context: () => Context | null;
  select?: (signal: AbortSignal) => Promise<string | null>;
  onError: (error: unknown) => void;
}) {
  let operation: AbortController | null = null;
  return {
    request(resumeTransferId?: string): boolean {
      if (resumeTransferId !== undefined && parseResumeFileRequest(`request-file-resume ${resumeTransferId}`) !== resumeTransferId) return false;
      const context = options.context();
      if (operation || !context) return false;
      const controller = new AbortController();
      operation = controller;
      const requestId = resumeTransferId ?? `reverse-${randomUUID()}`;
      let sending = false;
      let terminal = false;
      const notify = (state: WebRtcFileStatusMessage["state"]) => {
        if (terminal || options.context()?.key !== context.key) return;
        if (state !== "selecting" && state !== "sending") terminal = true;
        try { context.sendStatus?.({ type: "file-status", requestId, state }); } catch { /* Status must not break cleanup. */ }
      };
      const cancelled = () => notify("cancelled");
      controller.signal.addEventListener("abort", cancelled, { once: true });
      const current = () => !controller.signal.aborted && options.context()?.key === context.key;
      notify("selecting");
      // Do not await the dialog in the input command queue: it needs remote mouse input.
      void (async () => {
        const sourcePath = await (options.select ?? selectFileToSend)(controller.signal);
        if (!current()) return;
        if (!sourcePath) { notify("cancelled"); return; }
        sending = true; notify("sending");
        await context.sendFile({ sourcePath, transferId: requestId, signal: controller.signal });
        if (current()) notify("complete");
      })().catch(error => {
        if (current()) {
          notify(sending ? "send-failed" : "selection-failed");
          try { options.onError(error); } catch { /* Keep the command queue independent. */ }
        }
      }).finally(() => {
        controller.signal.removeEventListener("abort", cancelled);
        if (operation === controller) operation = null;
      });
      return true;
    },
    cancel(): void { operation?.abort(); },
  };
}
