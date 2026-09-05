import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");

describe("Agent compact UI and product icons", () => {
  it("keeps the active Agent screen non-scrolling with black text", () => {
    const app = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const styles = readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    const activeScreenStart = app.indexOf("if (registeredConfig)");
    const activeScreenEnd = app.indexOf(
      '<main className="login-screen agent-screen">',
      app.indexOf('<main className="login-screen agent-screen">', activeScreenStart) + 1,
    );
    const activeScreen = app.slice(activeScreenStart, activeScreenEnd);

    expect(activeScreen).toContain("active-agent-panel");
    expect(activeScreen).toContain("active-agent-result");
    expect(activeScreen).toContain("AgentRestartDialog");
    expect(activeScreen).not.toContain("alert(");
    expect(activeScreen).not.toContain('color: "#fff"');
    expect(styles).toContain(".agent-screen");
    expect(styles).toMatch(/\.agent-screen\s*\{[^}]*background: #ffffff;[^}]*padding: 0;/s);
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain(".active-agent-result strong");
    expect(styles).toContain("color: #111827;");
  });

  it("assigns distinct Viewer and Agent icon sources", () => {
    const viewerConfig = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"));
    const agentConfig = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.agent.conf.json"), "utf8"));
    const agentX86Config = JSON.parse(readFileSync(path.join(projectRoot, "src-tauri", "tauri.agent.x86.conf.json"), "utf8"));
    const viewerSvg = readFileSync(path.join(projectRoot, "src-tauri", "icons", "viewer.svg"), "utf8");
    const agentSvg = readFileSync(path.join(projectRoot, "src-tauri", "icons", "agent.svg"), "utf8");

    expect(viewerConfig.bundle.icon).toEqual(["icons/viewer.ico"]);
    expect(agentConfig.bundle.icon).toEqual(["icons/agent.ico"]);
    expect(agentX86Config.bundle.icon).toEqual(["icons/agent.ico"]);
    expect(viewerSvg).toContain('fill="#1c7a70"');
    expect(viewerSvg).toContain('fill="#000000"');
    expect(agentSvg).toContain('fill="#1c7a70"');
    expect(agentSvg).toContain('fill="#000000"');
    expect(agentSvg).toContain("<title>WonRemote Agent A</title>");
    expect(existsSync(path.join(projectRoot, "src-tauri", "icons", "viewer.ico"))).toBe(true);
    expect(existsSync(path.join(projectRoot, "src-tauri", "icons", "agent.ico"))).toBe(true);
    expect(readFileSync(path.join(projectRoot, "src-tauri", "icons", "viewer.ico"))).not.toEqual(
      readFileSync(path.join(projectRoot, "src-tauri", "icons", "agent.ico")),
    );
  });

  it("loads the Agent icon in the x86 native tray path", () => {
    const rustShell = readFileSync(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(rustShell).toContain('join("agent.ico")');
    expect(rustShell).toContain("LoadImageW(");
    expect(rustShell).toContain("LR_LOADFROMFILE");
    expect(rustShell).toContain("DestroyIcon(self.icon)");
  });
});
