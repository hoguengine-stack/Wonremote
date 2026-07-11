import { describe, expect, it } from "vitest";
import { parseAgentDisplayInventory } from "./agentDisplayInventory";

describe("Agent display inventory", () => {
  it("preserves positive and negative virtual desktop coordinates", () => {
    expect(
      parseAgentDisplayInventory([
        { index: 0, name: "Primary", x: 0, y: 0, width: 1920, height: 1080, primary: true },
        { index: 1, name: "Left", x: -1280, y: 120, width: 1280, height: 1024, primary: false },
      ]),
    ).toEqual([
      { index: 0, name: "Primary", x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { index: 1, name: "Left", x: -1280, y: 120, width: 1280, height: 1024, primary: false },
    ]);
  });

  it("keeps compatibility with display payloads that do not contain coordinates", () => {
    expect(
      parseAgentDisplayInventory([{ index: 0, width: 1024, height: 768, primary: true }]),
    ).toEqual([{ index: 0, name: "Display 0", width: 1024, height: 768, primary: true }]);
  });
});
