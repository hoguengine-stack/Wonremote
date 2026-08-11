import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tauriSource = readFileSync(path.join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");

describe("Viewer tray restart", () => {
  it("schedules a fresh Viewer process before exiting the current one", () => {
    expect(tauriSource).toContain("fn schedule_viewer_restart");
    expect(tauriSource).toContain("Start-Sleep -Milliseconds 750");
    expect(tauriSource).toContain("Start-Process -FilePath");
    expect(tauriSource).toContain("schedule_viewer_restart(&executable)");
    expect(tauriSource).toContain("Ok(()) => restart_app.exit(0)");
    expect(tauriSource).not.toContain("restart_app.restart();");
  });
});
