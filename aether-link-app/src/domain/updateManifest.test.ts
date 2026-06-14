import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  buildProductionUpdateSignaturePayload,
  parseProductionUpdateManifest,
} from "./updateManifest";

describe("production update manifest", () => {
  it("normalizes a signed Windows installer manifest into update metadata", () => {
    expect(
      parseProductionUpdateManifest({
        version: "0.1.8",
        windows: {
          x64: {
            name: "WonRemote Viewer_0.1.8_x64-setup.exe",
            url: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.8/WonRemote%20Viewer_0.1.8_x64-setup.exe",
            sha256: "a".repeat(64),
            signature: "base64-signature-placeholder",
          },
        },
      }),
    ).toEqual({
      assetName: "WonRemote Viewer_0.1.8_x64-setup.exe",
      checksum: "a".repeat(64),
      downloadUrl:
        "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.8/WonRemote%20Viewer_0.1.8_x64-setup.exe",
      forceUpdate: false,
      latestVersion: "0.1.8",
      reloadViewer: false,
      signature: "base64-signature-placeholder",
      updateKind: "installer",
    });
  });

  it("rejects manifests without an HTTPS installer URL and SHA-256 checksum", () => {
    expect(() =>
      parseProductionUpdateManifest({
        version: "0.1.8",
        windows: {
          x64: {
            url: "http://example.com/WonRemote.exe",
            sha256: "bad",
          },
        },
      }),
    ).toThrow("valid HTTPS installer URL");
  });

  it("verifies a signed manifest when a public key is configured", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifest = {
      version: "0.1.8",
      windows: {
        x64: {
          name: "WonRemote Viewer_0.1.8_x64-setup.exe",
          url: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.8/WonRemote.exe",
          sha256: "c".repeat(64),
        },
      },
    };
    const payload = buildProductionUpdateSignaturePayload({
      assetName: manifest.windows.x64.name,
      checksum: manifest.windows.x64.sha256,
      downloadUrl: manifest.windows.x64.url,
      latestVersion: manifest.version,
    });
    const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(
      parseProductionUpdateManifest(
        {
          ...manifest,
          windows: {
            x64: {
              ...manifest.windows.x64,
              signature,
            },
          },
        },
        { publicKeyPem },
      ).signature,
    ).toBe(signature);

    expect(() =>
      parseProductionUpdateManifest(
        {
          ...manifest,
          windows: {
            x64: {
              ...manifest.windows.x64,
              sha256: "d".repeat(64),
              signature,
            },
          },
        },
        { publicKeyPem },
      ),
    ).toThrow("signature verification failed");
  });
});
