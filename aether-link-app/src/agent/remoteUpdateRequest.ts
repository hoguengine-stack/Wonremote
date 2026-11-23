export function createRemoteUpdateRequest(hasSession: () => boolean) {
  let latest = 0;
  let pending: { update: () => Promise<void>; requested: boolean } | undefined;
  let busy = false;
  let closed = false;
  return {
    dispose() { closed = true; pending = undefined; },
    hasPendingRequest() { return pending?.requested === true; },
    defer(update: () => Promise<void>, requested = false) {
      if (!closed && (requested || !pending?.requested)) pending = { update, requested };
    },
    async receive(action: string, update: () => Promise<void>, now = Date.now()) {
      const match = /^request-update (\d{13})$/.exec(action);
      const at = Number(match?.[1]);
      if (closed || !match || at <= latest || now - at > 60_000 || at > now + 5_000 || busy) return false;
      latest = at;
      pending = { update, requested: true };
      await this.drain();
      return true;
    },
    async drain() {
      if (closed || !pending || busy || hasSession()) return;
      const { update } = pending;
      pending = undefined;
      busy = true;
      try { await update(); } finally { busy = false; }
    },
  };
}
