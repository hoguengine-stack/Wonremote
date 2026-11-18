import { describe, expect, it } from "vitest";
import { nativeCommandErrorMessage } from "./nativeCommandError";

describe("native command failure details", () => {
  it.each(["bundled Node runtime is missing: runtime/node.exe", "Access is denied. (os error 5)", "Production update signature is invalid"])("retains native String rejection: %s", message => {
    expect(nativeCommandErrorMessage(message, "Unknown failure")).toBe(message);
    expect(nativeCommandErrorMessage(new Error(message), "Unknown failure")).toBe(message);
  });
  it.each([null, undefined, {}, "  ", new Error("")])("uses an honest fallback for empty failures", error => {
    expect(nativeCommandErrorMessage(error, "Failed; reason unavailable")).toBe("Failed; reason unavailable");
  });
});
