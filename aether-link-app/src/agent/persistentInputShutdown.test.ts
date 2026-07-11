import { describe, expect, it, vi } from "vitest";
import { createAgentPointerState, recordSuccessfulPointerAction } from "./agentPointerState";
import {
  releasePressedInput,
  releasePressedInputAndClose,
} from "./persistentInputShutdown";

describe("persistent input shutdown", () => {
  it("releases tracked keys in reverse order before closing the child", async () => {
    const events: string[] = [];
    const pressedKeys = new Set(["Ctrl", "Shift", "A"]);
    const pointer = createAgentPointerState();
    const injector = {
      inject: vi.fn(async (action: string) => {
        events.push(action);
      }),
      close: vi.fn((reason: string) => {
        events.push(`close:${reason}`);
      }),
    };

    await releasePressedInputAndClose(injector, { pointer, pressedKeys }, "session stopped");

    expect(events).toEqual([
      "key-up A",
      "key-up Shift",
      "key-up Ctrl",
      "close:session stopped",
    ]);
    expect(pressedKeys.size).toBe(0);
  });

  it("continues releasing other keys and closes after one key-up failure", async () => {
    const pressedKeys = new Set(["Ctrl", "Shift"]);
    const pointer = createAgentPointerState();
    const warn = vi.fn();
    const injector = {
      inject: vi.fn(async (action: string) => {
        if (action === "key-up Shift") {
          throw new Error("pipe failed");
        }
      }),
      close: vi.fn(),
    };

    await releasePressedInputAndClose(injector, { pointer, pressedKeys }, "session changed", warn);

    expect(injector.inject).toHaveBeenNthCalledWith(1, "key-up Shift");
    expect(injector.inject).toHaveBeenNthCalledWith(2, "key-up Ctrl");
    expect(injector.close).toHaveBeenCalledWith("session changed");
    expect(warn).toHaveBeenCalledOnce();
    expect(pressedKeys.size).toBe(0);
  });

  it("releases a held mouse button without closing the persistent child on channel reconnect", async () => {
    const pointer = createAgentPointerState();
    recordSuccessfulPointerAction("mouse-down 123 456 left", pointer);
    const injector = {
      inject: vi.fn(async () => undefined),
      close: vi.fn(),
    };

    await releasePressedInput(injector, { pointer, pressedKeys: new Set() });

    expect(injector.inject).toHaveBeenCalledWith("mouse-up 123 456 left");
    expect(injector.close).not.toHaveBeenCalled();
    expect(pointer.pressedButtons.size).toBe(0);
  });
});
