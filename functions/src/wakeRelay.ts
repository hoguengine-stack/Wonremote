export interface WakeRelayCandidate {
  businessNumber?: unknown;
  id: string;
  lastSeenAt?: unknown;
  ownerUid?: unknown;
  status?: unknown;
}

export function normalizeWakeMac(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const compact = value.trim().replace(/[:-]/g, "").toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(compact) || compact === "000000000000" || compact === "FFFFFFFFFFFF") {
    return null;
  }
  return compact.match(/.{2}/g)?.join(":") ?? null;
}

export function selectWakeRelay(
  candidates: WakeRelayCandidate[],
  input: {
    businessNumber: string;
    nowMs: number;
    ownerUid: string;
    targetDeviceId: string;
    ttlMs?: number;
  },
): WakeRelayCandidate | null {
  const ttlMs = input.ttlMs ?? 60_000;
  return candidates
    .filter((candidate) => {
      const lastSeenAtMs = timestampMs(candidate.lastSeenAt);
      return (
        candidate.id !== input.targetDeviceId &&
        candidate.ownerUid === input.ownerUid &&
        candidate.businessNumber === input.businessNumber &&
        candidate.status === "online" &&
        lastSeenAtMs > 0 &&
        input.nowMs - lastSeenAtMs <= ttlMs
      );
    })
    .sort((left, right) => timestampMs(right.lastSeenAt) - timestampMs(left.lastSeenAt))[0] ?? null;
}

function timestampMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object") {
    if ("toMillis" in value && typeof value.toMillis === "function") {
      return Number(value.toMillis()) || 0;
    }
    if ("toDate" in value && typeof value.toDate === "function") {
      return value.toDate().getTime();
    }
  }
  return 0;
}
