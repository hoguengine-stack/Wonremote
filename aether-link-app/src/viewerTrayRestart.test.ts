import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tauriSource = readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");

describe("Viewer tray restart", () => {
  it("forwards a pinned Viewer relaunch to the existing window without restarting or touching Agent requests", () => {
    const duplicate = tauriSource.slice(tauriSource.indexOf("Ok(None) => {", tauriSource.indexOf("pub fn run()")),
      tauriSource.indexOf("Err(error) => {", tauriSource.indexOf("pub fn run()")));
    expect(duplicate).toContain("if !is_agent");
    expect(duplicate).toContain("viewer_activation::activate_existing()");
    expect(duplicate).toContain("request_existing_agent_window()");
    expect(duplicate).not.toContain("restart_viewer_from_tray");
    expect(duplicate).not.toContain("schedule_viewer_restart");
    expect(duplicate).not.toContain("start_agent_runtime");
    const viewerSetup = tauriSource.slice(tauriSource.indexOf("// Viewer Mode Setup"), tauriSource.indexOf("// System Tray Menu Setup for Viewer"));
    expect(viewerSetup).toContain("viewer_activation::mark_main_window");
    const show = tauriSource.slice(tauriSource.indexOf("fn show_main_window_with_log"), tauriSource.indexOf("fn spawn_agent_only_process"));
    expect(show).toContain("window.unminimize()");
    expect(show).toContain("match window.is_minimized()");
    expect(show).not.toContain("if launched_as_agent()");
  });
  it("schedules a fresh Viewer process before exiting the current one", () => {
    const restartStart = tauriSource.indexOf("fn restart_viewer_from_tray");
    const restartEnd = tauriSource.indexOf("fn start_installer_update", restartStart);
    const restartBlock = tauriSource.slice(restartStart, restartEnd);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(restartEnd).toBeGreaterThan(restartStart);
    expect(tauriSource).toContain("fn schedule_viewer_restart");
    expect(tauriSource).toContain("Start-Sleep -Milliseconds 750");
    expect(tauriSource).toContain("Start-Process -FilePath");
    expect(restartBlock).toContain("schedule_viewer_restart(&executable)");
    expect(restartBlock).toContain("Ok(()) => app.exit(0)");
    expect(restartBlock).not.toContain("app.restart();");
  });
});
