import { describe, expect, it } from "vitest";
import { resolveDeviceTypeEditor, resolveDeviceTypeValue } from "./deviceType";

describe("device type editor", () => {
  it("defaults generated Agent names to the main POS type", () => {
    expect(resolveDeviceTypeEditor("Agent AGENT-A3685AE1")).toEqual({
      choice: "메인포스",
      value: "메인포스",
    });
  });

  it("keeps known presets and preserves existing custom names", () => {
    expect(resolveDeviceTypeEditor("오더포스")).toEqual({ choice: "오더포스", value: "오더포스" });
    expect(resolveDeviceTypeEditor("주방 KDS")).toEqual({ choice: "custom", value: "주방 KDS" });
  });

  it("trims custom values before persistence", () => {
    expect(resolveDeviceTypeValue("custom", "  키오스크  ")).toBe("키오스크");
    expect(resolveDeviceTypeValue("메인포스", "ignored")).toBe("메인포스");
  });
});
