import { createHmac } from "node:crypto";

export interface TemporaryTurnCredential {
  credential: string;
  expiresAt: string;
  username: string;
}

export function createTemporaryTurnCredential(input: {
  identity: string;
  nowMs?: number;
  secret: string;
  ttlSeconds?: number;
}): TemporaryTurnCredential {
  const secret = input.secret.trim();
  const identity = input.identity.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  if (!secret || !identity) {
    throw new Error("TURN shared secret and authenticated identity are required.");
  }
  const ttlSeconds = Math.max(60, Math.min(86_400, Math.trunc(input.ttlSeconds ?? 3_600)));
  const expiresAtSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000) + ttlSeconds;
  const username = `${expiresAtSeconds}:${identity}`;
  return {
    credential: createHmac("sha1", secret).update(username).digest("base64"),
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    username,
  };
}
