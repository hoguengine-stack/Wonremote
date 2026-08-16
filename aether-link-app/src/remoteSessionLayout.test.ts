import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
const stylesSource = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
const capabilitySource = readFileSync(path.join(projectRoot, "src-tauri", "capabilities", "default.json"), "utf8");

function connectedReturnBlock(): string {
  const pendingBranch = appSource.indexOf('if (session.state === "pending")');
  const start = appSource.indexOf("return (", pendingBranch);
  const end = appSource.indexOf("\n  );\n}", start);
  expect(pendingBranch).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe("connected remote session layout", () => {
  it("keeps counters, diagnostics, and input log out of the connected panel", () => {
    const block = connectedReturnBlock();
    expect(block).not.toContain("frames {streamFrameCount}");
    expect(block).not.toContain("last {streamLastFrameAt}");
    expect(block).not.toContain("session-diagnostics");
    expect(block).not.toContain("input-log");
    expect(block).not.toContain("inputLog.map");
    expect(block).not.toContain('onInputEvent("keypress A")');
    expect(appSource).toContain("buildKeyboardCommand(\"keydown\", event.key, event.code, event.keyCode)");
    expect(appSource).toContain("buildKeyboardCommand(\"keyup\", event.key, event.code, event.keyCode)");
    expect(appSource).toContain("isHangulToggleKey(event.key, event.code, event.keyCode)");
    expect(appSource.match(/isHangulToggleKey\(event\.key, event\.code, event\.keyCode\)/g)).toHaveLength(3);
  });

  it("keeps a focused IME input sink for Korean composition without duplicating key events", () => {
    const block = connectedReturnBlock();
    expect(block).toContain('className="remote-ime-input"');
    expect(block).toContain("onCompositionStart");
    expect(block).toContain("onCompositionEnd={handleImeCompositionEnd}");
    expect(block).toContain("onInput={handleImeInput}");
    expect(block).toContain("event.stopPropagation()");
    expect(appSource).toContain("imeInputRef.current?.focus({ preventScroll: true })");
    expect(appSource).toContain("buildUnicodeTextCommand(text)");
    expect(appSource).toContain('event.key === "Process" || event.keyCode === 229');
    expect(appSource).toContain("completedImeTextRef.current");
    expect(stylesSource).toContain(".remote-ime-input");
  });

  it("places actions before the remote work area and exposes fullscreen control", () => {
    const block = connectedReturnBlock();
    expect(block).toContain('className="session-actions session-actions-top"');
    expect(stylesSource).toContain(".session-actions-top");
    expect(stylesSource).toContain("order: -1");
    expect(block).toContain("toggleSessionFullscreen");
    expect(block).toContain("isSessionFullscreen");
    expect(block).toContain("session-fullscreen-active");
    expect(block).toContain('className="session-fullscreen-exit"');
    expect(block).toContain("isFullscreenToolbarOpen");
    expect(block).toContain("session-fullscreen-tools-open");
    expect(block).toContain('className="session-fullscreen-toolbar-toggle"');
    expect(block).toContain('title="전체화면 전환"');
  });

  it("removes the titlebar from the connected panel and styles", () => {
    const block = connectedReturnBlock();
    expect(block).not.toContain("remote-titlebar");
    expect(block).not.toContain("remote-titlebar-identity");
    expect(block).not.toContain("remote-titlebar-status");
    expect(stylesSource).not.toContain("remote-titlebar");
    expect(stylesSource).not.toContain("remote-titlebar-identity");
    expect(stylesSource).not.toContain("remote-titlebar-status");
  });

  it("checks for a Viewer update before asking the user to install it", () => {
    expect(appSource).toContain('className="viewer-update-button"');
    expect(appSource).toContain('invoke("start_installer_update", { restartMode: "viewer" })');
    expect(appSource).toContain("isManualUpdateChecking");
    expect(appSource).toContain('setViewerUpdateDialog({ kind: "available"');
    expect(appSource).toContain("function ViewerUpdateDialog");
    expect(stylesSource).toContain(".viewer-update-button");
  });

  it("provides a device-list refresh action without a build-time dependency", () => {
    expect(appSource).toContain("const handleRefreshDeviceList");
    expect(appSource).toContain('className="section-refresh-button"');
    expect(stylesSource).toContain(".section-refresh-button");
  });

  it("keeps hover movement for remote menus while rate limiting it", () => {
    const start = appSource.indexOf("const handleCanvasMouseMove");
    const end = appSource.indexOf("const handleCanvasWheel", start);
    const moveBlock = appSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(moveBlock).not.toContain("pressedButtonsRef.current.size === 0");
    expect(moveBlock).toContain("moveDelayTimerRef.current");
    expect(moveBlock).toContain("33 - (performance.now() - lastMoveSentAtRef.current)");
    expect(moveBlock).toContain("requestAnimationFrame");
  });

  it("defines flexible focus-mode layout hooks without legacy log panels", () => {
    expect(stylesSource).toContain(".session-actions-top");
    expect(stylesSource).toContain(".remote-focus-mode .remote-work-area");
    expect(stylesSource).toContain(".remote-focus-mode .session-actions-top");
    expect(stylesSource).toContain("order: -1");
    expect(stylesSource).toContain("overflow: visible");
    expect(stylesSource).toContain(
      ".session-fullscreen-active:not(.session-fullscreen-tools-open) .session-actions-top",
    );
    expect(stylesSource).toContain(
      ".session-fullscreen-active.session-fullscreen-tools-open .session-actions-top",
    );
    expect(stylesSource).toContain(".session-fullscreen-active .remote-work-area");
    expect(stylesSource).toContain(".session-fullscreen-active .remote-screen");
    expect(stylesSource).toContain(".session-fullscreen-active .remote-preview");
    expect(stylesSource).toContain("position: fixed !important;");
    expect(stylesSource).toContain("height: 100vh !important;");
    expect(stylesSource).toContain("width: 100vw;");
    expect(stylesSource).toContain("max-height");
    expect(stylesSource).toContain("overflow-y");
    expect(capabilitySource).toContain("core:window:allow-is-fullscreen");
    expect(capabilitySource).toContain("core:window:allow-set-fullscreen");
    expect(stylesSource).not.toMatch(/^\.input-log\s*\{/m);
    expect(stylesSource).not.toMatch(/^\.session-diagnostics\s*\{/m);
    expect(stylesSource).not.toMatch(/^\.diagnostic-pill(?:\.warning)?\s*\{/m);
  });
});
