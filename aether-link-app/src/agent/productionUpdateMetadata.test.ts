import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildProductionUpdateSignaturePayload,
  buildProductionUpdateSignaturePayloadV2,
} from "../domain/updateManifest";
import {
  loadProductionInstallerUpdateMetadata,
  resolveRuntimeUpdateKind,
} from "./productionUpdateMetadata";

describe("production update metadata loader", () => {
  it("loads and verifies the signed GitHub release manifest without the local API server", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifestUrl = "https://example.com/wonremote-update-manifest.json";
    const manifest = {
      version: "0.1.10",
      windows: {
        x86: {
          name: "WonRemote-Viewer-Setup.exe",
          url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Setup.exe",
          sha256: "a".repeat(64),
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
    const signatureV2 = sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({
      arch: "x86",
      assetName: manifest.windows.x86.name,
      checksum: manifest.windows.x86.sha256,
      downloadUrl: manifest.windows.x86.url,
      forceUpdate: false,
      latestVersion: manifest.version,
      updateKind: "installer",
    }), "utf8"), privateKey).toString("base64");
    const requestedUrls: string[] = [];

    const metadata = await loadProductionInstallerUpdateMetadata(
      {
        WONREMOTE_BUILD_ARCH: "x86",
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
        WONREMOTE_UPDATE_MANIFEST_URL: manifestUrl,
      },
      async (url) => {
        requestedUrls.push(String(url));
        return new Response(
          JSON.stringify({
            ...manifest,
            windows: {
              x86: {
                ...manifest.windows.x86,
                signature,
                signatureV2,
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
    const signatureV2 = sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({
      arch: "x86",
      assetName: manifest.windows.x86.name,
      checksum: manifest.windows.x86.sha256,
      downloadUrl: manifest.windows.x86.url,
      forceUpdate: false,
      latestVersion: manifest.version,
      updateKind: "installer",
    }), "utf8"), privateKey).toString("base64");

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
                signatureV2,
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

  it("prefers agentWindows over the legacy windows section for Agent updates", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const asset = {
      name: "WonRemote-Agent-Setup.exe",
      url: "https://updates.example.com/WonRemote-Agent-Setup.exe",
      sha256: "e".repeat(64),
    };
    const signature = sign(null, Buffer.from(buildProductionUpdateSignaturePayload({
      assetName: asset.name,
      checksum: asset.sha256,
      downloadUrl: asset.url,
      latestVersion: "0.1.47",
    }), "utf8"), privateKey).toString("base64");
    const signatureV2 = sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({
      arch: "x86",
      assetName: asset.name,
      checksum: asset.sha256,
      downloadUrl: asset.url,
      forceUpdate: false,
      latestVersion: "0.1.47",
      updateKind: "installer",
    }), "utf8"), privateKey).toString("base64");
    const metadata = await loadProductionInstallerUpdateMetadata(
      {
        WONREMOTE_BUILD_ARCH: "x86",
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
        WONREMOTE_UPDATE_MANIFEST_URL: "https://updates.example.com/manifest.json",
      },
      async () => new Response(JSON.stringify({
        version: "0.1.47",
        agentWindows: { x86: { ...asset, signature, signatureV2 } },
        windows: { x64: { name: "legacy.exe", url: "https://updates.example.com/legacy.exe", sha256: "f".repeat(64) } },
      }), { status: 200 }),
    );
    expect(metadata?.assetName).toBe("WonRemote-Agent-Setup.exe");
  });

  it("selects the signed portable product declared by the packaged runtime", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const asset = {
      name: "WonRemote-Agent-Portable-x86.zip",
      url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Agent-Portable-x86.zip",
      sha256: "c".repeat(64),
    };
    const signature = sign(
      null,
      Buffer.from(buildProductionUpdateSignaturePayload({
        assetName: asset.name,
        checksum: asset.sha256,
        downloadUrl: asset.url,
        latestVersion: "0.1.40",
      }), "utf8"),
      privateKey,
    ).toString("base64");
    const signatureV2 = sign(
      null,
      Buffer.from(buildProductionUpdateSignaturePayloadV2({
        arch: "x86",
        assetName: asset.name,
        checksum: asset.sha256,
        downloadUrl: asset.url,
        forceUpdate: false,
        latestVersion: "0.1.40",
        updateKind: "portable-agent",
      }), "utf8"),
      privateKey,
    ).toString("base64");

    const metadata = await loadProductionInstallerUpdateMetadata(
      {
        WONREMOTE_BUILD_ARCH: "x86",
        WONREMOTE_PACKAGE_KIND: "portable-agent",
        WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
      async () => new Response(JSON.stringify({
        version: "0.1.40",
        portableAgent: { x86: { ...asset, signature, signatureV2 } },
      })),
    );

    expect(metadata).toMatchObject({
      assetName: asset.name,
      updateKind: "portable-agent",
    });
  });

  it("defaults invalid or missing package kinds to installer updates", () => {
    expect(resolveRuntimeUpdateKind({})).toBe("installer");
    expect(resolveRuntimeUpdateKind({ WONREMOTE_PACKAGE_KIND: "portable" })).toBe("portable");
    expect(resolveRuntimeUpdateKind({ WONREMOTE_PACKAGE_KIND: "portable-agent" })).toBe("portable-agent");
    expect(resolveRuntimeUpdateKind({ WONREMOTE_PACKAGE_KIND: "unknown" })).toBe("installer");
  });
});
