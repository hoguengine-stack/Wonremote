import assert from "node:assert/strict";
import test from "node:test";
import { createTemporaryTurnCredential } from "./turnCredentials.js";

test("creates deterministic coturn REST credentials with a bounded lifetime", () => {
  const credential = createTemporaryTurnCredential({
    identity: "viewer/user@example.com",
    nowMs: 1_700_000_000_000,
    secret: "shared-secret",
    ttlSeconds: 600,
  });
  assert.equal(credential.username, "1700000600:viewer_user_example.com");
  assert.equal(credential.expiresAt, "2023-11-14T22:23:20.000Z");
  assert.equal(credential.credential, "20Sbw/rGsRc8/RjeeB7ZFgZ/rIc=");
});

test("rejects an empty identity or secret", () => {
  assert.throws(() => createTemporaryTurnCredential({ identity: "", secret: "secret" }));
  assert.throws(() => createTemporaryTurnCredential({ identity: "viewer", secret: "" }));
});
