import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWER_UPDATE_MANIFEST_URL, fetchViewerUpdateMetadata } from "./viewerUpdate";

describe("viewer update metadata", () => {
  it("checks the signed stable release manifest instead of the local API server", async () => {
    const requestedUrls: string[] = [];

    const metadata = await fetchViewerUpdateMetadata(
      {},
      async (url) => {
        requestedUrls.push(String(url));
        return new Response(
          JSON.stringify({
            version: "0.1.24",
            windows: {
              x64: {
                name: "WonRemote-Viewer-Agent-Setup.exe",
                url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Setup.exe",
                sha256: "a".repeat(64),
              },
            },
          }),
          { status: 200 },
        );
      },
    );

    expect(requestedUrls[0]).toMatch(
      /^https:\/\/github\.com\/hoguengine-stack\/Wonremote\/releases\/latest\/download\/wonremote-update-manifest\.json\?nocache=/,
    );
    expect(requestedUrls[0]).not.toContain("127.0.0.1");
    expect(metadata).toMatchObject({
      latestVersion: "0.1.24",
      reloadViewer: false,
    });
  });

  it("allows an explicit manifest URL override for controlled deployments", async () => {
    const requestedUrls: string[] = [];

    await fetchViewerUpdateMetadata(
      { VITE_WONREMOTE_UPDATE_MANIFEST_URL: "https://updates.example.com/manifest.json?channel=stable" },
      async (url) => {
        requestedUrls.push(String(url));
        return new Response(
          JSON.stringify({
            version: "0.1.25",
            installer: {
              url: "https://updates.example.com/WonRemote-Setup.exe",
              sha256: "b".repeat(64),
            },
          }),
          { status: 200 },
        );
      },
    );

    expect(requestedUrls[0]).toMatch(/^https:\/\/updates\.example\.com\/manifest\.json\?channel=stable&nocache=/);
  });

  it("selects x86 update metadata for x86 Viewer builds", async () => {
    const metadata = await fetchViewerUpdateMetadata(
      {
        VITE_WONREMOTE_BUILD_ARCH: "ia32",
        VITE_WONREMOTE_UPDATE_MANIFEST_URL: "https://updates.example.com/manifest.json",
      },
      async () => {
        return new Response(
          JSON.stringify({
            version: "0.1.26",
            windows: {
              x64: {
                url: "http://updates.example.com/WonRemote-Viewer-Agent-Setup.exe",
                sha256: "a".repeat(64),
              },
              x86: {
                url: "https://updates.example.com/WonRemote-Viewer-Agent-Setup-x86.exe",
                sha256: "b".repeat(64),
              },
            },
          }),
          { status: 200 },
        );
      },
    );

    expect(metadata).toMatchObject({
      latestVersion: "0.1.26",
      reloadViewer: false,
    });
  });

  it("ignores unsafe or incomplete release manifests", async () => {
    await expect(
      fetchViewerUpdateMetadata({}, async () => {
        return new Response(
          JSON.stringify({
            version: "0.1.24",
            installer: {
              url: "http://updates.example.com/WonRemote-Setup.exe",
              sha256: "not-a-sha",
            },
          }),
          { status: 200 },
        );
      }),
    ).resolves.toBeNull();
  });

  it("keeps the stable signed manifest URL independent of release versions", () => {
    expect(DEFAULT_VIEWER_UPDATE_MANIFEST_URL).toBe(
      "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/wonremote-update-manifest.json",
    );
  });
});
