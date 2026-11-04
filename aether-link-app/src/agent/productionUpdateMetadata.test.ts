import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildProductionUpdateSignaturePayload,
  buildProductionUpdateSignaturePayloadV2,
} from "../domain/updateManifest";
import {
  loadProductionInstallerUpdateMetadata,
  resolveRuntimeUpdateKind,
} from "./productionUpdateMetadata";

describe("production update metadata loader", () => {
  it("keeps Agent120 on the legacy endpoint while Viewer122 uses its own signed discovery", async () => {
    const {privateKey,publicKey}=generateKeyPairSync("ed25519");
    const signed=(product:string,version:string)=>{
      const asset={name:`WonRemote-${product}-Setup.exe`,url:`https://github.com/hoguengine-stack/Wonremote/releases/download/v${version}/WonRemote-${product}-Setup.exe`,sha256:"a".repeat(64)};
      const data={assetName:asset.name,downloadUrl:asset.url,checksum:asset.sha256,latestVersion:version};
      return {...asset,signature:sign(null,Buffer.from(buildProductionUpdateSignaturePayload(data)),privateKey).toString("base64"),
        signatureV2:sign(null,Buffer.from(buildProductionUpdateSignaturePayloadV2({...data,arch:"x86",forceUpdate:false,updateKind:"installer"})),privateKey).toString("base64")};
    };
    const agent={version:"0.1.120",agentWindows:{x86:signed("Agent","0.1.120")}};
    const viewer={version:"0.1.122",viewerWindows:{x86:signed("Viewer","0.1.122")}};
    const requests:string[]=[];
    const fetcher=async(url:any)=>{requests.push(String(url));return new Response(JSON.stringify(String(url).startsWith("https://wonremote-a7fd3.web.app/updates/viewer-latest.json")?viewer:agent));};
    const env={WONREMOTE_BUILD_ARCH:"x86",WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY:publicKey.export({type:"spki",format:"pem"}).toString()};
    expect((await loadProductionInstallerUpdateMetadata(env,fetcher))?.latestVersion).toBe("0.1.120");
    expect((await loadProductionInstallerUpdateMetadata({...env,WONREMOTE_UPDATE_PRODUCT:"viewer"},fetcher))?.latestVersion).toBe("0.1.122");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("releases/latest/download/wonremote-update-manifest.json");
    expect(requests[1]).toContain("web.app/updates/viewer-latest.json");
    await expect(loadProductionInstallerUpdateMetadata({...env,WONREMOTE_UPDATE_PRODUCT:"viewer"},async()=>new Response(JSON.stringify({...viewer,version:"0.1.123"})))).rejects.toThrow("signature");
    const combined={version:"0.1.127",viewerWindows:{x86:signed("Viewer","0.1.127")},agentWindows:{x86:signed("Agent","0.1.127")}};
    for(const product of ["viewer","agent"])expect((await loadProductionInstallerUpdateMetadata({...env,WONREMOTE_UPDATE_PRODUCT:product},async()=>new Response(JSON.stringify(combined))))?.latestVersion).toBe("0.1.127");
  });
  it("bounds a stalled update response instead of indefinitely holding native checks", async () => {
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let received: AbortSignal | undefined;
    try {
      const pending = loadProductionInstallerUpdateMetadata({}, async (_url, options) => {
        received = options?.signal as AbortSignal;
        const signal = received;
        return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
      expect(deadline).toHaveBeenCalledWith(15_000);
      expect(received).toBe(controller.signal);
      controller.abort(new DOMException("Update deadline", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({name:"TimeoutError"});
    } finally { deadline.mockRestore(); }
  });
  it("selects file replacement only for capable installed Agents and rejects its invalid signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const version = "9.9.9";
    const signed = (role: string) => {
      const asset = { name: `WonRemote-Agent-${role}.exe`, url: `https://updates.example.com/${role}.exe`, sha256: "a".repeat(64) };
      const metadata = { assetName: asset.name, downloadUrl: asset.url, checksum: asset.sha256, latestVersion: version };
      return { ...asset,
        signature: sign(null, Buffer.from(buildProductionUpdateSignaturePayload(metadata)), privateKey).toString("base64"),
        signatureV2: sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({ ...metadata, arch: "x86", forceUpdate: false, updateKind: "installer" })), privateKey).toString("base64"),
      };
    };
    const setup = signed("Setup"); const update = signed("Update");
    const manifest = { version, agentWindows: { x86: setup }, agentInstallers: { x86: setup }, agentFileUpdates: { x86: update }, viewerWindows: { x86: setup } };
    const env = { WONREMOTE_BUILD_ARCH: "x86", WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString() };
    const fetcher = async () => new Response(JSON.stringify(manifest));
    expect((await loadProductionInstallerUpdateMetadata(env, fetcher))?.assetName).toBe(setup.name);
    const capable = { ...env, WONREMOTE_AGENT_FILE_UPDATE: "1" };
    expect((await loadProductionInstallerUpdateMetadata(capable, fetcher))?.assetName).toBe(update.name);
    expect((await loadProductionInstallerUpdateMetadata({ ...capable, WONREMOTE_UPDATE_PRODUCT: "viewer" }, fetcher))?.assetName).toBe(setup.name);
    expect((await loadProductionInstallerUpdateMetadata(capable, fetcher, true))?.assetName).toBe(setup.name);
    const historical = { version, agentWindows: { x86: setup } };
    expect((await loadProductionInstallerUpdateMetadata(capable, async () => new Response(JSON.stringify(historical))))?.assetName).toBe(setup.name);
    await expect(loadProductionInstallerUpdateMetadata(capable, async () => new Response(JSON.stringify({ ...manifest,
      agentFileUpdates: { x86: { ...update, sha256: "b".repeat(64) } },
    })))).rejects.toThrow("signature");
  });
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

  it.each(["Setup", "Update"])("accepts signed Agent %s executables without changing the legacy handoff protocol", async (role) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const asset = {
      name: `WonRemote-Agent-${role}.exe`,
      url: `https://updates.example.com/WonRemote-Agent-${role}.exe`,
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
    expect(metadata?.assetName).toBe(`WonRemote-Agent-${role}.exe`);
    expect(metadata?.updateKind).toBe("installer");
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
