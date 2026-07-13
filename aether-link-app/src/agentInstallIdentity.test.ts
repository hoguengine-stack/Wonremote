import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

describe("Agent install identity persistence", () => {
  it("resolves the Agent install id outside WebView storage before registration", () => {
    expect(appSource).toContain('invoke<string>("get_or_create_agent_install_id"');
    expect(appSource).toContain("legacyInstallId: installId");
    expect(appSource).toContain("isSubmitting || !isInstallIdentityReady");
    expect(tauriSource).toContain('join("agent-install-id")');
    expect(tauriSource).toContain("load_or_create_agent_install_id");
    expect(tauriSource).toContain("get_or_create_agent_install_id,");
  });
});
