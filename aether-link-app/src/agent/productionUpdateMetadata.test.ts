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
});
