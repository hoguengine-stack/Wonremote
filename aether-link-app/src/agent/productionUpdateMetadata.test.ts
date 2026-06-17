import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildProductionUpdateSignaturePayload } from "../domain/updateManifest";
import { loadProductionInstallerUpdateMetadata } from "./productionUpdateMetadata";

describe("production update metadata loader", () => {
  it("loads and verifies the signed GitHub release manifest without the local API server", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifestUrl = "https://example.com/wonremote-update-manifest.json";
    const manifest = {
      version: "0.1.10",
      windows: {
        x64: {
          name: "WonRemote-Viewer-Setup.exe",
          url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Setup.exe",
          sha256: "a".repeat(64),
        },
      },
    };
    const signaturePayload = buildProductionUpdateSignaturePayload({
      assetName: manifest.windows.x64.name,
      checksum: manifest.windows.x64.sha256,
      downloadUrl: manifest.windows.x64.url,
      latestVersion: manifest.version,
    });
    const signature = sign(null, Buffer.from(signaturePayload, "utf8"), privateKey).toString("base64");
    const requestedUrls: string[] = [];

    const metadata = await loadProductionInstallerUpdateMetadata(
      {
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
        WONREMOTE_UPDATE_MANIFEST_URL: manifestUrl,
      },
      async (url) => {
        requestedUrls.push(String(url));
        return new Response(
          JSON.stringify({
            ...manifest,
            windows: {
              x64: {
                ...manifest.windows.x64,
                signature,
              },
            },
          }),
          { status: 200 },
        );
      },
    );

    expect(requestedUrls[0]).toMatch(/^https:\/\/example\.com\/wonremote-update-manifest\.json\?nocache=/);
    expect(metadata).toMatchObject({
      assetName: "WonRemote-Viewer-Setup.exe",
      latestVersion: "0.1.10",
      updateKind: "installer",
    });
  });

  it("loads the signed x86 installer metadata for 32-bit Agent builds", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifestUrl = "https://example.com/wonremote-update-manifest.json";
    const manifest = {
      version: "0.1.26",
      windows: {
        x64: {
          name: "WonRemote-Viewer-Agent-Setup.exe",
          url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Setup.exe",
          sha256: "a".repeat(64),
        },
        x86: {
          name: "WonRemote-Viewer-Agent-Setup-x86.exe",
          url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Setup-x86.exe",
          sha256: "b".repeat(64),
        },
      },
    };
    const signaturePayload = buildProductionUpdateSignaturePayload({
      assetName: manifest.windows.x86.name,
      checksum: manifest.windows.x86.sha256,
      downloadUrl: manifest.windows.x86.url,
      latestVersion: manifest.version,
    });
    const signature = sign(null, Buffer.from(signaturePayload, "utf8"), privateKey).toString("base64");

    const metadata = await loadProductionInstallerUpdateMetadata(
      {
        WONREMOTE_BUILD_ARCH: "ia32",
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
        WONREMOTE_UPDATE_MANIFEST_URL: manifestUrl,
      },
      async () => {
        return new Response(
          JSON.stringify({
            ...manifest,
            windows: {
              ...manifest.windows,
              x86: {
                ...manifest.windows.x86,
                signature,
              },
            },
          }),
          { status: 200 },
        );
      },
    );

    expect(metadata).toMatchObject({
      assetName: "WonRemote-Viewer-Agent-Setup-x86.exe",
      latestVersion: "0.1.26",
      updateKind: "installer",
    });
  });
});
