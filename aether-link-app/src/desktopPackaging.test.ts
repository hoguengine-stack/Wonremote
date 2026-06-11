import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));

describe("desktop packaging scaffold", () => {
  it("uses Tauri with the existing Vite build output", () => {
    const configPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.build).toMatchObject({
      beforeDevCommand: "npm run dev",
      beforeBuildCommand: "npm run build",
      devUrl: "http://127.0.0.1:5173",
      frontendDist: "../dist",
    });
    expect(config.productName).toBe("AetherLink Viewer");
    expect(config.version).toBe(packageJson.version);
  });

  it("exposes desktop packaging npm scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      "desktop:dev": "tauri dev",
      "desktop:build": "tauri build",
    });
    expect(packageJson.devDependencies["@tauri-apps/cli"]).toBeDefined();
  });

  it("keeps the Rust shell version aligned with the app package version", () => {
    const cargoToml = readFileSync(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8");

    expect(cargoToml).toContain(`version = "${packageJson.version}"`);
  });
});
