import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
const stylesSource = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");

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
  });

  it("places actions before the remote work area and exposes fullscreen control", () => {
    const block = connectedReturnBlock();
    expect(block).toContain('className="session-actions session-actions-top"');
    expect(stylesSource).toContain(".session-actions-top");
    expect(stylesSource).toContain("order: -1");
    expect(block).toContain("toggleSessionFullscreen");
    expect(block).toContain("isSessionFullscreen");
    expect(block).toContain('title="전체화면 전환"');
  });

  it("keeps the desktop identity immediately before transport state in the titlebar", () => {
    const block = connectedReturnBlock();
    const titlebar = block.slice(block.indexOf("remote-titlebar"), block.indexOf("remote-preview"));
    expect(titlebar).toContain("device.desktopName");
    expect(titlebar.indexOf("device.desktopName")).toBeLessThan(titlebar.indexOf("streamTransportState"));
  });

  it("defines flexible focus-mode layout hooks without legacy log panels", () => {
    expect(stylesSource).toContain(".session-actions-top");
    expect(stylesSource).toContain(".remote-titlebar-identity");
    expect(stylesSource).toContain(".remote-titlebar-status");
    expect(stylesSource).toContain(".remote-focus-mode .remote-work-area");
    expect(stylesSource).toContain(".remote-focus-mode .session-actions-top");
    expect(stylesSource).toContain("order: -1");
    expect(stylesSource).toContain("overflow: visible");
    expect(stylesSource).not.toMatch(/^\.input-log\s*\{/m);
    expect(stylesSource).not.toMatch(/^\.session-diagnostics\s*\{/m);
  });
});
