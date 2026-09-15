import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("exchanges input responses through two real Windows broker pipes", () => {
  const output = execFileSync("cargo", [
    "test", "--release", "--target", "i686-pc-windows-msvc",
    "input_roundtrips_through_two_real_duplex_pipes", "--", "--nocapture",
  ], {
    cwd: path.resolve(process.cwd(), "../aether-link-poc"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  expect(output).toContain("1 passed; 0 failed");
}, 125_000);
