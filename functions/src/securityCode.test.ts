import assert from "node:assert/strict";
import test from "node:test";
import { generateSecurityCode } from "./securityCode.js";

test("generateSecurityCode formats the full randomInt range as six digits", () => {
  assert.equal(generateSecurityCode(() => 0), "000 000");
  assert.equal(generateSecurityCode(() => 999_999), "999 999");
});

test("generateSecurityCode requests an unbiased integer in [0, 1000000)", () => {
  let requestedRange: [number, number] | undefined;
  const code = generateSecurityCode((min, max) => {
    requestedRange = [min, max];
    return 123_456;
  });

  assert.deepEqual(requestedRange, [0, 1_000_000]);
  assert.equal(code, "123 456");
});

test("generateSecurityCode rejects a broken random source", () => {
  assert.throws(() => generateSecurityCode(() => 1_000_000), RangeError);
});
