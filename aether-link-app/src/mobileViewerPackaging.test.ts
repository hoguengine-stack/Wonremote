import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();

describe("mobile Viewer packaging", () => {
  it("installs the Viewer route without reusing the Windows update flow", () => {
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, "public", "manifest.webmanifest"), "utf8"));
    const app = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const main = readFileSync(path.join(projectRoot, "src", "main.tsx"), "utf8");

    expect(manifest).toMatchObject({ id: "/viewer", start_url: "/viewer", display: "standalone" });
    expect(main).toContain('navigator.serviceWorker.register("/viewer-sw.js")');
    expect(app).toContain('isMobileViewer ? " mobile-viewer"');
    expect(app).toContain("!isMobileViewer && <button");
  });
});
