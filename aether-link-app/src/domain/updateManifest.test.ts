import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  buildProductionUpdateSignaturePayload,
  buildProductionUpdateSignaturePayloadV2,
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
      signatureV2: undefined,
      updateKind: "installer",
    });
  });

  it("selects the x86 Windows installer when requested", () => {
    expect(
      parseProductionUpdateManifest(
        {
          version: "0.1.8",
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
        },
        { arch: "x86" },
      ),
    ).toMatchObject({
      assetName: "WonRemote-Viewer-Agent-Setup-x86.exe",
      checksum: "b".repeat(64),
      downloadUrl:
        "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Agent-Setup-x86.exe",
    });
  });

  it("verifies the same x86 installer independently for legacy x64 and x86 clients", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const viewer = {
      name: "WonRemote-Viewer-Setup.exe",
      url: "https://github.com/hoguengine-stack/Wonremote/releases/download/v9.9.9/WonRemote-Viewer-Setup.exe",
      sha256: "f".repeat(64),
    };
    const signedAsset = (asset: typeof viewer, arch: "x64" | "x86") => ({
      ...asset,
      signature: sign(null, Buffer.from(buildProductionUpdateSignaturePayload({ assetName: asset.name, checksum: asset.sha256, downloadUrl: asset.url, latestVersion: "9.9.9" }), "utf8"), privateKey).toString("base64"),
      signatureV2: sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({ arch, assetName: asset.name, checksum: asset.sha256, downloadUrl: asset.url, forceUpdate: false, latestVersion: "9.9.9", updateKind: "installer" }), "utf8"), privateKey).toString("base64"),
    });
    const manifest = {
      version: "9.9.9",
      viewerWindows: { x64: signedAsset(viewer, "x64"), x86: signedAsset(viewer, "x86") },
    };
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(parseProductionUpdateManifest(manifest, { arch: "x64", product: "viewer", publicKeyPem })).toMatchObject({ assetName: viewer.name, latestVersion: "9.9.9" });
    expect(parseProductionUpdateManifest(manifest, { arch: "x86", product: "viewer", publicKeyPem })).toMatchObject({ assetName: viewer.name, latestVersion: "9.9.9" });
    expect(() => parseProductionUpdateManifest({
      ...manifest,
      viewerWindows: { ...manifest.viewerWindows, x64: manifest.viewerWindows.x86 },
    }, { arch: "x64", product: "viewer", publicKeyPem })).toThrow("v2 signature verification failed");
  });

  it.each([
    ["portable", "portable", "WonRemote-Viewer-Agent-Portable-x86.zip"],
    ["portable-agent", "portableAgent", "WonRemote-Agent-Portable-x86.zip"],
  ] as const)("selects the signed x86 %s asset without changing installer compatibility", (assetKind, section, name) => {
    expect(
      parseProductionUpdateManifest(
        {
          version: "0.1.39",
          [section]: {
            x86: {
              name,
              url: `https://github.com/hoguengine-stack/Wonremote/releases/latest/download/${name}`,
              sha256: "e".repeat(64),
            },
          },
        },
        { arch: "x86", assetKind },
      ),
    ).toMatchObject({
      assetName: name,
      checksum: "e".repeat(64),
      updateKind: assetKind,
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
        x86: {
          name: "WonRemote Viewer_0.1.8_x64-setup.exe",
          url: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.8/WonRemote.exe",
          sha256: "c".repeat(64),
        },
      },
    };
    const payload = buildProductionUpdateSignaturePayload({
      assetName: manifest.windows.x86.name,
      checksum: manifest.windows.x86.sha256,
      downloadUrl: manifest.windows.x86.url,
      latestVersion: manifest.version,
    });
    const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    const payloadV2 = buildProductionUpdateSignaturePayloadV2({
      arch: "x86",
      assetName: manifest.windows.x86.name,
      checksum: manifest.windows.x86.sha256,
      downloadUrl: manifest.windows.x86.url,
      forceUpdate: false,
      latestVersion: manifest.version,
      updateKind: "installer",
    });
    const signatureV2 = sign(null, Buffer.from(payloadV2, "utf8"), privateKey).toString("base64");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(
      parseProductionUpdateManifest(
        {
          ...manifest,
          windows: {
            x86: {
              ...manifest.windows.x86,
              signature,
              signatureV2,
            },
          },
        },
        { arch: "x86", publicKeyPem },
      ).signature,
    ).toBe(signature);

    expect(() =>
      parseProductionUpdateManifest(
        {
          ...manifest,
          windows: {
            x86: {
              ...manifest.windows.x86,
              sha256: "d".repeat(64),
              signature,
              signatureV2,
            },
          },
        },
        { arch: "x86", publicKeyPem },
      ),
    ).toThrow("signature verification failed");

    expect(() =>
      parseProductionUpdateManifest(
        {
          ...manifest,
          forceUpdate: true,
          windows: {
            x86: {
              ...manifest.windows.x86,
              signature,
              signatureV2,
            },
          },
        },
        { arch: "x86", publicKeyPem },
      ),
    ).toThrow("v2 signature verification failed");
  });
});
