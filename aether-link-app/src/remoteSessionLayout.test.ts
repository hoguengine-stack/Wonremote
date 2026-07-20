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
    expect(appSource.match(/isHangulToggleKey\(event\.key, event\.code, event\.keyCode\)/g)).toHaveLength(2);
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
