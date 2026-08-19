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
    expect(appSource.match(/isHangulToggleKey\(event\.key, event\.code, event\.keyCode\)/g)).toHaveLength(1);
  });

  it("routes Hangul and printable text through a local IME sink without remote Hangul toggles", () => {
    const block = connectedReturnBlock();
    expect(block).toContain('className="remote-ime-input"');
    expect(block).toContain("onCompositionStart");
    expect(appSource).toContain("imeInputRef.current?.focus({ preventScroll: true })");
    expect(appSource).toContain("buildUnicodeTextCommand");
    expect(appSource).toContain("const hangulToggle = isHangulToggleKey");
    expect(appSource).not.toContain('onInputEvent("keypress Hangul")');
    expect(appSource).toContain("event.target !== imeInputRef.current");
    expect(appSource).not.toContain("event.currentTarget !== imeInputRef.current");
    expect(stylesSource).toContain(".remote-ime-input");
  });

  it("keeps Ctrl shortcuts on the raw key down and key up path", () => {
    const start = appSource.indexOf("const handleKeyDown");
    const end = appSource.indexOf("const handleKeyUp", start);
    const keyDownBlock = appSource.slice(start, end);
    const pasteStart = keyDownBlock.indexOf('event.ctrlKey && event.key.toLowerCase() === "v"');
    const pasteEnd = keyDownBlock.indexOf("const isLocalText", pasteStart);
    const pasteBlock = keyDownBlock.slice(pasteStart, pasteEnd);

    expect(pasteStart).toBeGreaterThanOrEqual(0);
    expect(pasteEnd).toBeGreaterThan(pasteStart);
    expect(pasteBlock).toContain("buildPasteTextCommand(text)");
    expect(pasteBlock).not.toContain('onInputEvent("key-up Ctrl")');
    expect(keyDownBlock).toContain('buildKeyboardCommand("keydown"');
    expect(appSource).toContain('buildKeyboardCommand("keyup"');
  });

  it("deduplicates pointer transitions and cancels delayed movement on release", () => {
    expect(appSource).toContain("pressTrackedMouseButton(pressedButtonsRef.current, e.button)");
    expect(appSource).toContain("releaseTrackedMouseButton(pressedButtonsRef.current, e.button)");
    expect(appSource).toContain("releaseTrackedMouseButton(pressedButtonsRef.current, event.button)");
    expect(appSource).toContain("setPointerCapture(e.pointerId)");
    expect(appSource).toContain("releasePointerCapture(e.pointerId)");
    expect(appSource).toContain("onPointerCancel={handleCanvasPointerCancel}");
    expect(appSource).toContain("onLostPointerCapture={handleCanvasPointerCancel}");
    expect(appSource).toContain("const cancelPendingPointerMove");
    expect(appSource).toContain("pendingMoveRef.current = null");
    expect(appSource).toContain("cancelPendingPointerMove();");
    expect(appSource).toContain("releaseAllInputs();");
  });

  it("releases tracked keys after focus moves to an internal control", () => {
    const start = appSource.indexOf("const handleKeyUp");
    const end = appSource.indexOf("useEffect(() =>", start);
    const keyUpBlock = appSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(keyUpBlock).toContain("releaseTrackedKey(pressedKeysRef.current");
    expect(keyUpBlock).not.toContain("isEditableTarget(event.target)");
  });

  it("releases held mouse buttons at the last remote pointer position", () => {
    const start = appSource.indexOf("const releaseAllInputs");
    const end = appSource.indexOf("const handlePanelBlur", start);
    const releaseBlock = appSource.slice(start, end);

    expect(releaseBlock).toContain("lastPointerPointRef.current");
    expect(releaseBlock).not.toContain("rect.left + rect.width / 2");
  });

  it("places actions before the remote work area and exposes fullscreen control", () => {
    const block = connectedReturnBlock();
    expect(block).toContain('className="session-actions session-actions-top remote-command-bar"');
    expect(stylesSource).toContain(".session-actions-top");
    expect(stylesSource).toContain("order: -1");
    expect(block).toContain("toggleSessionFullscreen");
    expect(block).toContain("isSessionFullscreen");
    expect(block).toContain("session-fullscreen-active");
    expect(block).toContain('className="session-fullscreen-exit"');
    expect(block).toContain("창모드");
    expect(appSource).toContain("useState(true)");
    expect(appSource).toContain("setIsSessionFullscreen(true)");
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
    const start = appSource.indexOf("const handleCanvasPointerMove");
    const end = appSource.indexOf("const handleCanvasWheel", start);
    const moveBlock = appSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(moveBlock).not.toContain("pressedButtonsRef.current.size === 0");
    expect(moveBlock).toContain("moveDelayTimerRef.current");
    expect(moveBlock).toContain("33 - (performance.now() - lastMoveSentAtRef.current)");
    expect(moveBlock).toContain("requestAnimationFrame");
  });

  it("keeps secondary tools in one overlay menu and removes duplicate monitor buttons", () => {
    const block = connectedReturnBlock();
    expect(block).toContain('className="session-tool-menu"');
    expect(block).toContain('className="session-tool-menu-content"');
    expect(block).not.toContain("display-button-");
    expect(block).not.toContain('name: "Fallback"');
    expect(stylesSource).toContain(".session-tool-menu-content");
    expect(stylesSource).toContain("position: absolute;");
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
    expect(stylesSource).toContain(".remote-canvas");
    expect(stylesSource).toMatch(
      /\.session-fullscreen-active \.remote-preview canvas\s*\{[^}]*height: auto !important;[^}]*max-height: 100%;[^}]*max-width: 100%;[^}]*width: auto !important;/s,
    );
    expect(stylesSource).toMatch(
      /\.remote-focus-mode \.remote-preview canvas\s*\{[^}]*height: auto !important;[^}]*max-height: 100%;[^}]*max-width: 100%;[^}]*width: auto !important;/s,
    );
    expect(stylesSource).not.toMatch(
      /(?:\.session-fullscreen-active \.remote-preview canvas|\.remote-focus-mode \.remote-preview canvas|\.remote-canvas)\s*\{[^}]*object-fit:/s,
    );
    expect(capabilitySource).toContain("core:window:allow-is-fullscreen");
    expect(capabilitySource).toContain("core:window:allow-set-fullscreen");
    expect(stylesSource).not.toMatch(/^\.input-log\s*\{/m);
    expect(stylesSource).not.toMatch(/^\.session-diagnostics\s*\{/m);
    expect(stylesSource).not.toMatch(/^\.diagnostic-pill(?:\.warning)?\s*\{/m);
  });
});
