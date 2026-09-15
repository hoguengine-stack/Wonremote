import type { SessionData } from "./sessionData";

type ClipboardSubscription = (
  onData: (data: SessionData) => void,
  onError: (error: Error) => void,
  onReady: () => void,
) => () => void;

export function requestFreshClipboardText({
  request,
  signal,
  subscribe,
  timeoutMs = 10_000,
}: {
  request: () => void | Promise<void>;
  signal?: AbortSignal;
  subscribe: ClipboardSubscription;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("클립보드 요청이 취소되었습니다.", "AbortError"));
      return;
    }

    let settled = false;
    let requestSent = false;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeWhenAvailable = false;
    const stop = () => {
      if (unsubscribe) {
        const current = unsubscribe;
        unsubscribe = null;
        current();
      } else {
        unsubscribeWhenAvailable = true;
      }
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stop();
      complete();
    };
    const onAbort = () => finish(
      () => reject(new DOMException("클립보드 요청이 취소되었습니다.", "AbortError")),
    );
    const timer = setTimeout(() => {
      finish(() => reject(new Error("원격 클립보드 응답 시간 초과")));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      unsubscribe = subscribe(
        (data) => {
          if (!requestSent || settled) return;
          const response = [...data.clipboards].reverse().find((item) => item.sender === "agent");
          if (response) finish(() => resolve(response.text));
        },
        (error) => finish(() => reject(error)),
        () => {
          if (requestSent || settled) return;
          requestSent = true;
          try {
            void Promise.resolve(request()).catch((error) => {
              finish(() => reject(error instanceof Error ? error : new Error(String(error))));
            });
          } catch (error) {
            finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        },
      );
      if (unsubscribeWhenAvailable) stop();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
