import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { build as bundleNode } from "esbuild";
import { build as bundleDesktop } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProductionUpdateSignaturePayload, buildProductionUpdateSignaturePayloadV2 } from "./domain/updateManifest";

describe("Windows installer product boundaries", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["viewer", "agent"] as const)("emits only the %s UI", async (product) => {
    vi.stubEnv("WONREMOTE_DESKTOP_PRODUCT", product);
    const result = await bundleDesktop({
      logLevel: "silent",
      build: { write: false, outDir: "dist-desktop" },
    });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []);
    const js = chunks.map(chunk => chunk.type === "chunk" ? chunk.code : "").join("\n");
    const viewerScreen = "Viewer 관리자 로그인";
    const agentScreen = "Agent 가동 중";
    expect(js).toContain(product === "viewer" ? viewerScreen : agentScreen);
    expect(js).not.toContain(product === "viewer" ? agentScreen : viewerScreen);
    expect(js).not.toContain("get_app_mode");
  }, 20_000);

  it("leaves the hosted and mobile web entry points in the shared build", async () => {
    vi.stubEnv("WONREMOTE_DESKTOP_PRODUCT", "");
    const result = await bundleDesktop({ logLevel: "silent", build: { write: false } });
    const files = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []);
    expect(files.map(file => file.fileName)).toEqual(expect.arrayContaining(["index.html", "video-support.html"]));
    const js = files.map(file => file.type === "chunk" ? file.code : "").join("\n");
    expect(js).toContain("Viewer 관리자 로그인");
    expect(js).toContain("Agent 가동 중");
  }, 20_000);

  it("excludes the Agent runtime from the Viewer updater and rejects Agent startup before network access", async () => {
    const result = await bundleNode({
      entryPoints: ["src/agent/viewerUpdater.ts"],
      platform: "node",
      format: "esm",
      bundle: true,
      metafile: true,
      write: false,
    });
    expect(Object.keys(result.metafile.inputs)).not.toContain("src/agent/index.ts");
    expect(Object.keys(result.metafile.inputs)).not.toContain("src/firebase/agentFirebase.ts");
    const run = (args: string[], setup: string, env: NodeJS.ProcessEnv = process.env) =>
      spawnSync(process.execPath, ["--input-type=module", "-", ...args], {
        input: setup + "\n" + result.outputFiles[0].text,
        env,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
    for (const args of [[], ["--watch"], ["--update-once", "--restart-mode", "agent"]]) {
      const cli = run(args, 'globalThis.fetch = () => { throw new Error("unexpected network"); };');
      expect(cli.status).toBe(2);
      expect(cli.stderr).not.toContain("unexpected network");
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const version = "9.9.9";
    const name = "WonRemote-Viewer-Setup.exe";
    const url = `https://github.com/hoguengine-stack/Wonremote/releases/download/v${version}/${name}`;
    const sha256 = "a".repeat(64);
    const signed = { assetName: name, downloadUrl: url, checksum: sha256, latestVersion: version };
    const manifest = { version, viewerWindows: { x86: {
      name, url, sha256,
      signature: sign(null, Buffer.from(buildProductionUpdateSignaturePayload(signed)), privateKey).toString("base64"),
      signatureV2: sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({
        ...signed, arch: "x86", forceUpdate: false, updateKind: "installer",
      })), privateKey).toString("base64"),
    } } };
    const env = {
      ...process.env,
      WONREMOTE_UPDATE_PRODUCT: "agent",
      WONREMOTE_SELECTED_VIEWER_UPDATE: "0",
      WONREMOTE_PACKAGE_KIND: "installer",
      WONREMOTE_BUILD_ARCH: "x86",
      WONREMOTE_UPDATE_MANIFEST_URL: "",
      WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const check = (body: object) => run(["--check-update"], `
      globalThis.fetch = async url => {
        if (!String(url).startsWith("https://wonremote-a7fd3.web.app/updates/viewer-latest.json?")) {
          throw new Error("unexpected endpoint");
        }
        return new Response(${JSON.stringify(JSON.stringify(body))});
      };
    `, env);
    const valid = check(manifest);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain('[WonRemoteUpdateCheck]{"available":true,"latestVersion":"9.9.9"}');
    const tampered = check({ ...manifest, version: "9.9.8" });
    expect(tampered.status).toBe(3);
    expect(tampered.stderr).toContain("signature");
  });
});
