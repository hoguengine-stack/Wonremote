import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("Viewer pointer lifecycle", () => {
  it("repairs missed releases before queuing the next pointer move", () => {
    expect(appSource).toContain("releaseTrackedMouseButtonsMissingFromMask(");
    expect(appSource).toMatch(
      /releaseTrackedMouseButtonsMissingFromMask[\s\S]*cancelPendingPointerMove\(\);[\s\S]*buildMouseCommand\("up"/,
    );
  });

  it("cancels delayed movement before every direct pointer release", () => {
    expect(appSource).toMatch(
      /const handleCanvasPointerUp[\s\S]*cancelPendingPointerMove\(\);[\s\S]*buildMouseCommand\("up"/,
    );
  });

  it("recovers pointer release globally and when capture is cancelled", () => {
    expect(appSource).toContain('window.addEventListener("pointerup", handleWindowPointerUp, true)');
    expect(appSource).toContain('window.addEventListener("pointercancel", handleWindowPointerCancel, true)');
    expect(appSource).toContain("onLostPointerCapture={handleCanvasPointerCancel}");
  });

  it("does not let a different pointer release an active mouse drag", () => {
    expect(appSource).toContain("const activePointerIdRef = React.useRef<number | null>(null)");
    expect(appSource).toMatch(
      /handleCanvasPointerMove[\s\S]*activePointerIdRef\.current !== e\.pointerId[\s\S]*return;/,
    );
    expect(appSource).toMatch(
      /handleWindowPointerUp[\s\S]*activePointerIdRef\.current !== event\.pointerId[\s\S]*return;/,
    );
  });

  it("keeps pointer capture until every tracked mouse button is released", () => {
    expect(appSource).toContain(`if (pressedButtonsRef.current.size === 0) {
      activePointerIdRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }`);
  });
});
