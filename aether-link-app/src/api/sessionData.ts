import type { SessionData, SessionDataOptions } from "../domain/sessionData";

// One outstanding request waits for a change. There is no idle polling or automatic error retry.
export function subscribeLocalSessionData(
  baseUrl: string, sessionId: string, target: "viewer" | "agent",
  onData: (data: SessionData) => void | Promise<void>, onError: (error: Error) => void,
  options: SessionDataOptions = {},
): () => void {
  const controller = new AbortController();
  const params = new URLSearchParams({ target, clipboard: String(options.clipboard !== false), queues: String(options.queues !== false) });
  for (const id of new Set(options.receiptIds ?? [])) params.append("receipt", id);
  let revision = -1;
  void (async () => {
    try {
      while (!controller.signal.aborted) {
        params.set("after", String(revision));
        const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Session events failed (${response.status}).`);
        const data = await response.json() as SessionData & { revision: number };
        if (controller.signal.aborted) return;
        if (!Number.isSafeInteger(data.revision) || data.revision <= revision) throw new Error("Invalid session event revision.");
        revision = data.revision;
        await onData(data);
        if (options.queues === false && options.receiptIds?.length && options.receiptIds.every((id) => data.receipts.some((receipt) => receipt.transferId === id && receipt.status !== "partial"))) return;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort();
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();
  return () => controller.abort();
}
