export interface AgentWebRtcOffer {
  negotiationId: string;
  sdp: string;
  type: "offer";
}

export const MAX_RECENT_AGENT_NEGOTIATION_IDS = 16;

export function parseAgentWebRtcOffer(input: unknown): AgentWebRtcOffer | null {
  if (!isRecord(input) || !isRecord(input.offer)) {
    return null;
  }
  const rootNegotiationId = readNonEmptyString(input.negotiationId);
  const offerNegotiationId = readNonEmptyString(input.offer.negotiationId);
  const negotiationId = offerNegotiationId ?? rootNegotiationId;
  if (
    !negotiationId ||
    (rootNegotiationId && offerNegotiationId && rootNegotiationId !== offerNegotiationId) ||
    input.offer.type !== "offer" ||
    typeof input.offer.sdp !== "string" ||
    !input.offer.sdp.trim()
  ) {
    return null;
  }
  return {
    negotiationId,
    sdp: input.offer.sdp,
    type: "offer",
  };
}

export function candidateMatchesNegotiation(input: unknown, negotiationId: string): boolean {
  return isRecord(input) && input.negotiationId === negotiationId && isRecord(input.candidate);
}

export function rememberNegotiationAttempt(
  recentNegotiationIds: Set<string>,
  negotiationId: string,
  maxRecent = MAX_RECENT_AGENT_NEGOTIATION_IDS,
): boolean {
  if (recentNegotiationIds.has(negotiationId)) {
    return false;
  }

  recentNegotiationIds.add(negotiationId);
  const boundedLimit = Math.max(1, Math.floor(maxRecent));
  while (recentNegotiationIds.size > boundedLimit) {
    const oldestNegotiationId = recentNegotiationIds.values().next().value;
    if (oldestNegotiationId === undefined) {
      break;
    }
    recentNegotiationIds.delete(oldestNegotiationId);
  }
  return true;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
