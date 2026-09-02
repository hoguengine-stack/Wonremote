import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tauriSource = readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");

describe("Viewer tray restart", () => {
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
