import { describe, expect, it } from "vitest";
import {
  createAgentPointerState,
  pointerReleaseActions,
  recordSuccessfulPointerAction,
  shouldInjectPointerAction,
} from "./agentPointerState";

describe("Agent pointer state", () => {
  it("tracks successful mouse-down at the latest pointer position", () => {
    const state = createAgentPointerState();

    recordSuccessfulPointerAction("mouse-down 100 200 left", state);
    recordSuccessfulPointerAction("move 300 400", state);

    expect(pointerReleaseActions(state)).toEqual(["mouse-up 300 400 left"]);
  });

  it("removes a button only after its mouse-up succeeds", () => {
    const state = createAgentPointerState();
    recordSuccessfulPointerAction("mouse-down 100 200 right", state);
    recordSuccessfulPointerAction("mouse-up 100 200 right", state);

    expect(pointerReleaseActions(state)).toEqual([]);
  });

  it("rejects duplicate down and unmatched up transitions", () => {
    const state = createAgentPointerState();
    expect(shouldInjectPointerAction("mouse-down 100 200 left", state)).toBe(true);
    recordSuccessfulPointerAction("mouse-down 100 200 left", state);
    expect(shouldInjectPointerAction("mouse-down 100 200 left", state)).toBe(false);
    expect(shouldInjectPointerAction("mouse-up 100 200 right", state)).toBe(false);
    expect(shouldInjectPointerAction("mouse-up 100 200 left", state)).toBe(true);
  });
});
