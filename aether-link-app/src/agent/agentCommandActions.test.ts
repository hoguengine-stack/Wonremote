import { describe, expect, it } from "vitest";
import { recordSuccessfulInjectAction, resolveInjectActions } from "./agentCommandActions";

describe("agent command actions", () => {
  it("updates key state only after injection succeeds", () => {
    const pressed = new Set<string>();

    expect(resolveInjectActions("key-down Ctrl", pressed)).toEqual({
      type: "inject",
      actions: ["key-down Ctrl"],
    });
    expect([...pressed]).toEqual([]);
    recordSuccessfulInjectAction("key-down Ctrl", pressed);
    expect([...pressed]).toEqual(["Ctrl"]);

    expect(resolveInjectActions("key-up Ctrl", pressed)).toEqual({
      type: "inject",
      actions: ["key-up Ctrl"],
    });
    expect([...pressed]).toEqual(["Ctrl"]);
    recordSuccessfulInjectAction("key-up Ctrl", pressed);
    expect([...pressed]).toEqual([]);
  });

  it("expands key-release-all without clearing keys before injection succeeds", () => {
    const pressed = new Set(["Ctrl", "Shift", "A"]);

    expect(resolveInjectActions("key-release-all", pressed)).toEqual({
      type: "inject",
      actions: ["key-up A", "key-up Shift", "key-up Ctrl"],
    });
    expect([...pressed]).toEqual(["Ctrl", "Shift", "A"]);
    for (const action of ["key-up A", "key-up Shift", "key-up Ctrl"]) {
      recordSuccessfulInjectAction(action, pressed);
    }
    expect([...pressed]).toEqual([]);
  });

  it("decodes paste-text-base64 into clipboard text plus paste injection", () => {
    const text = "한글 text 123";
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(text)));

    expect(resolveInjectActions(`paste-text-base64 ${payload}`, new Set())).toEqual({
      type: "pasteText",
      text,
      actions: ["paste"],
    });
    expect(resolveInjectActions(`paste_text ${payload}`, new Set())).toEqual({
      type: "pasteText",
      text,
      actions: ["paste"],
    });
  });

  it("accepts underscore key_release_all as a compatibility alias", () => {
    const pressed = new Set(["Ctrl", "V"]);

    expect(resolveInjectActions("key_release_all", pressed)).toEqual({
      type: "inject",
      actions: ["key-up V", "key-up Ctrl"],
    });
    expect([...pressed]).toEqual(["Ctrl", "V"]);
  });

  it("passes ordinary inject commands through unchanged", () => {
    expect(resolveInjectActions("mouse-wheel 10 20 -120", new Set())).toEqual({
      type: "inject",
      actions: ["mouse-wheel 10 20 -120"],
    });
  });

  it("parses security-code commands without treating them as input injection", async () => {
    const { parseSecurityCodeCommand } = await import("./agentCommandActions");

    expect(parseSecurityCodeCommand("security-code secure-123 987 654")).toEqual({
      challengeId: "secure-123",
      code: "987 654",
    });
    expect(parseSecurityCodeCommand("security-code broken")).toBeNull();
  });
});
