import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "mobile/android/collect-android-crash-log.ps1");

describe("Android crash log collector", () => {
  it("runs its device-free capture setup and cleanup check", () => {
    const output = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", script, "-SelfTest"], {
      encoding: "utf8", windowsHide: true,
    });
    expect(output).toContain("Self-test passed.");
  });
});
