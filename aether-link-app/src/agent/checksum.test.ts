import { describe, expect, it } from "vitest";
import { computeSha256 } from "./checksum";

describe("SHA-256 Checksum", () => {
  it("computes the correct hash for an empty buffer", () => {
    const emptyBuffer = Buffer.alloc(0);
    const hash = computeSha256(emptyBuffer);
    // SHA-256 for empty string: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("computes the correct hash for test string 'hello'", () => {
    const buffer = Buffer.from("hello");
    const hash = computeSha256(buffer);
    // SHA-256 for 'hello': 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
