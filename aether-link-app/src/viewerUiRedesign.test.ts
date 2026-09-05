import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
const stylesSource = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");

function connectedSessionSource(): string {
  const pendingBranch = appSource.indexOf('if (session.state === "pending")');
  const start = appSource.indexOf("return (", pendingBranch);
  const end = appSource.indexOf("\n  );\n}", start);
  expect(pendingBranch).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe("Viewer UI redesign contract", () => {
  it("defines a compact dashboard command header and device workspace", () => {
    expect(appSource).toContain('data-testid="viewer-command-header"');
    expect(appSource).toContain('data-testid="viewer-brand"');
    expect(appSource).toContain('data-testid="device-workspace"');
    expect(stylesSource).toContain(".viewer-command-header");
    expect(stylesSource).toContain(".device-workspace");
    expect(stylesSource).toMatch(/\.workspace-live-status\s*\{[^}]*white-space: nowrap;/s);
    expect(stylesSource).toMatch(/\.viewer-command-header \.viewer-update-button,[\s\S]*?white-space: nowrap;/);
    expect(appSource).toContain('name="username" type="text"');
  });

  it("gives the connected session a complete semantic command surface", () => {
    const block = connectedSessionSource();

    expect(block).toContain('data-testid="remote-command-bar"');
    expect(block).toContain('data-testid="remote-connection-status"');
    expect(block).toContain('role="status" aria-live="polite"');
    expect(block).toContain('data-action="back-to-devices"');
    expect(block).toContain('data-testid="display-mode-controls"');
    expect(block).toContain('data-testid="secondary-tools"');
    expect(block).toContain('data-testid="end-session"');
    expect(block).toContain('className="session-end-button destructive"');
  });

  it("keeps command-bar keyboard actions local instead of forwarding them remotely", () => {
    expect(appSource).toContain("target instanceof Element");
    expect(appSource).toContain("button, input, select, summary, textarea");
    expect(appSource).toContain("[role='button']");
  });

  it("keeps the remote canvas dominant and fullscreen tools collapsed", () => {
    const block = connectedSessionSource();

    expect(block).toContain('data-testid="remote-canvas-viewport"');
    expect(block).toContain('data-testid="fullscreen-toolbar-toggle"');
    expect(block).toContain("aria-expanded={isFullscreenToolbarOpen}");
    expect(stylesSource).toContain(".remote-canvas-viewport");
    expect(stylesSource).toMatch(/\.remote-canvas-viewport\s*\{[^}]*flex:\s*1\s+1\s+auto;/s);
    expect(stylesSource).toContain(
      ".session-fullscreen-active:not(.session-fullscreen-tools-open) .remote-command-bar",
    );
  });

  it("does not restore frame counters or an operation-log panel", () => {
    const block = connectedSessionSource();

    expect(block).not.toMatch(/frames\s*\{/i);
    expect(block).not.toContain("streamFrameCount");
    expect(block).not.toContain('data-testid="operation-log"');
    expect(block).not.toContain('className="operation-log"');
    expect(stylesSource).not.toMatch(/^\.operation-log\s*\{/m);
  });

  it("keeps per-device view settings and searchable operating details", () => {
    expect(appSource).toContain("deviceViewPreferencesKey(preferenceDeviceId)");
    expect(appSource).toContain("clipboardSync: isClipboardSyncOn");
    expect(appSource).toContain("selectedDisplayIndex,");
    expect(appSource).toContain("담당자");
    expect(appSource).toContain("설치 위치");
    expect(appSource).toContain("메모 / 장애 이력");
  });
});
