import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWakeMac, selectWakeRelay } from "./wakeRelay.js";

test("normalizeWakeMac accepts canonical device MAC values and rejects unsafe broadcast values", () => {
  assert.equal(normalizeWakeMac("aa-bb-cc-dd-ee-ff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeWakeMac("aabbccddeeff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeWakeMac("00:00:00:00:00:00"), null);
  assert.equal(normalizeWakeMac("FF:FF:FF:FF:FF:FF"), null);
  assert.equal(normalizeWakeMac("not-a-mac"), null);
});

test("selectWakeRelay chooses the freshest online Agent with the same owner and business", () => {
  const nowMs = Date.parse("2026-07-11T00:00:00.000Z");
  const relay = selectWakeRelay(
    [
      { id: "target", ownerUid: "owner", businessNumber: "123", status: "online", lastSeenAt: "2026-07-10T23:59:59.000Z" },
      { id: "wrong-owner", ownerUid: "other", businessNumber: "123", status: "online", lastSeenAt: "2026-07-10T23:59:59.000Z" },
      { id: "stale", ownerUid: "owner", businessNumber: "123", status: "online", lastSeenAt: "2026-07-10T23:58:00.000Z" },
      { id: "relay-old", ownerUid: "owner", businessNumber: "123", status: "online", lastSeenAt: "2026-07-10T23:59:40.000Z" },
      { id: "relay-new", ownerUid: "owner", businessNumber: "123", status: "online", lastSeenAt: "2026-07-10T23:59:50.000Z" },
    ],
    { businessNumber: "123", nowMs, ownerUid: "owner", targetDeviceId: "target" },
  );

  assert.equal(relay?.id, "relay-new");
});

test("selectWakeRelay returns null when no recent same-business Agent is online", () => {
  const nowMs = Date.parse("2026-07-11T00:00:00.000Z");
  assert.equal(
    selectWakeRelay(
      [{ id: "relay", ownerUid: "owner", businessNumber: "other", status: "online", lastSeenAt: "2026-07-10T23:59:59.000Z" }],
      { businessNumber: "123", nowMs, ownerUid: "owner", targetDeviceId: "target" },
    ),
    null,
  );
});
