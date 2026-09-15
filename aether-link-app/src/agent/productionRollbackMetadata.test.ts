import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildProductionUpdateSignaturePayload, buildProductionUpdateSignaturePayloadV2 } from "../domain/updateManifest";
import { loadProductionRollbackMetadata } from "./productionUpdateMetadata";
import { runUpdateOnce } from "./agentUpdateOnce";
import { downloadInstallerUpdate, prepareInstallerHandoff } from "./productionInstallerUpdate";

function fixture(options: { version?: string; url?: string; name?: string; tamper?: boolean; checksum?: string } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const name = options.name ?? "WonRemote-Agent-Setup.exe";
  const version = options.version ?? "0.1.90";
  const url = options.url ?? `https://github.com/hoguengine-stack/Wonremote/releases/download/v${version}/${name}`;
  const sha256 = options.checksum ?? "a".repeat(64);
  const signatureV2 = sign(null, Buffer.from(buildProductionUpdateSignaturePayloadV2({ arch: "x86", assetName: name, checksum: sha256,
    downloadUrl: url, forceUpdate: false, latestVersion: version, updateKind: "installer" })), privateKey).toString("base64");
  const signature = sign(null, Buffer.from(buildProductionUpdateSignaturePayload({ assetName: name, checksum: sha256,
    downloadUrl: url, latestVersion: version })), privateKey).toString("base64");
  const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ version, agentWindows: { x86: { name, url,
    sha256: options.tamper ? "b".repeat(64) : sha256, signature, signatureV2 } } })));
  const env = { WONREMOTE_BUILD_ARCH: "x86", WONREMOTE_UPDATE_PRODUCT: "agent", WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString() };
  return { env, fetcher };
}
it("loads only the requested older release and verifies its signed installer metadata", async () => {
  const { env, fetcher } = fixture();
  const result = await loadProductionRollbackMetadata("0.1.90", "0.2.0", env, fetcher);
  expect(result.latestVersion).toBe("0.1.90");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("/releases/download/v0.1.90/wonremote-update-manifest.json");
});
it("rejects malformed, equal and newer requests before any network access", async () => {
  const { env, fetcher } = fixture();
  for (const version of ["../latest", "0.2.0", "0.3.0", "0.1.90-beta", "01.1.90"]) {
    await expect(loadProductionRollbackMetadata(version, "0.2.0", env, fetcher)).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects signed wrong versions, wrong products, mutable URLs and tampered hashes", async () => {
  for (const options of [{ version: "0.1.89" }, { name: "WonRemote-Viewer-Setup.exe" },
    { url: "https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Agent-Setup.exe" }, { tamper: true }]) {
    const { env, fetcher } = fixture(options);
    await expect(loadProductionRollbackMetadata("0.1.90", "0.2.0", env, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it("joins signed rollback to real disk verification and handoff preparation, never launching corrupted bytes", async () => {
  const original = Buffer.from("non-executable installer fixture");
  const checksum = createHash("sha256").update(original).digest("hex");
  for (const corrupted of [false, true]) {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "wonremote-rollback-test-"));
    const { env, fetcher } = fixture({ checksum });
    const downloadFetch = vi.fn(async () => new Response(corrupted ? "corrupted" : original));
    const launch = vi.fn();
    const prepare = vi.fn(prepareInstallerHandoff);
    try {
      const promise = runUpdateOnce({ baseDir, restartMode: "agent", rollbackVersion: "0.1.90" }, {
        currentVersion: "0.2.0",
        loadMetadata: vi.fn(),
        loadRollbackMetadata: (version, current) => loadProductionRollbackMetadata(version, current, env, fetcher),
        downloadInstaller: (metadata, options) => downloadInstallerUpdate(metadata, { ...options, fetchImpl: downloadFetch }),
        prepareHandoff: prepare,
        downloadPortable: vi.fn(), preparePortableHandoff: vi.fn(), launchHandoff: launch,
      });
      if (corrupted) {
        await expect(promise).rejects.toThrow("checksum mismatch");
        expect(prepare).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
        expect(await readdir(path.join(baseDir, "WonRemote", "updates"))).toEqual([]);
      } else {
        await expect(promise).resolves.toMatchObject({ latestVersion: "0.1.90", status: "handoff-started" });
        expect(launch).toHaveBeenCalledTimes(1);
        const download = prepare.mock.calls[0][0];
        expect(await readFile(download.installerPath)).toEqual(original);
        const handoff = await prepare.mock.results[0].value;
        const script = await readFile(handoff.scriptPath, "utf8");
        expect(script).toContain("$TargetVersion = '0.1.90'");
        expect(script).toContain("$RestartMode = 'agent'");
      }
      expect(fetcher).toHaveBeenCalledTimes(1); expect(downloadFetch).toHaveBeenCalledTimes(1);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  }
});
