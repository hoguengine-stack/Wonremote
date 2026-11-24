import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  assertDraft, assertOwner, assertX86, bridge, draft, downloadPinned, loadStockParser, mergeLegacyManifest,
} from "./sign-120-legacy-manifest.js";

const loaded = await loadStockParser();
const { parser } = loaded;
const canonicalDigest = "d1a0f26cf44a9fdea20953beaaea2d4c67a67dc4099689eecfbe2b8ff4c080ec";
const canonicalUrl = "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.123/WonRemote-Agent-Update.exe";
const assetName = "WonRemote-Agent-Update.exe";
const signer = generateKeyPairSync("ed25519");
const ownerContext = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "hoguengine-stack/Wonremote",
  GITHUB_REPOSITORY_ID: "1136941328", GITHUB_REF: "refs/heads/codex/sign-wonremote-lock-tolerant-120-123",
  GITHUB_ACTOR: "hoguengine-stack", GITHUB_ACTOR_ID: "246740147", GITHUB_TRIGGERING_ACTOR: "hoguengine-stack",
};

function stockValidate(manifest, key) {
  return parser.parseProductionUpdateManifest({ ...manifest, agentWindows: manifest.agentFileUpdates }, {
    arch: "x86", product: "agent", assetKind: "installer", publicKeyPem: key,
  });
}

function canonicalFixture() {
  const target = { assetName, checksum: canonicalDigest, downloadUrl: canonicalUrl, latestVersion: "0.1.123",
    updateKind: "installer", arch: "x86", forceUpdate: false };
  const leaf = {
    name: assetName, url: canonicalUrl, sha256: canonicalDigest,
    signature: sign(null, Buffer.from(parser.buildProductionUpdateSignaturePayload(target)), signer.privateKey).toString("base64"),
    signatureV2: sign(null, Buffer.from(parser.buildProductionUpdateSignaturePayloadV2(target)), signer.privateKey).toString("base64"),
  };
  return { version: "0.1.123", forceUpdate: false, viewerWindows: { x86: { untouched: true } },
    agentInstallers: { x86: { untouched: true } }, portable: { untouched: ["fixture"] },
    agentFileUpdates: { x64: { untouched: true }, x86: leaf } };
}

test("requires the pinned workflow context before signed output is possible", () => {
  assert.doesNotThrow(() => assertOwner(ownerContext));
  for (const key of Object.keys(ownerContext)) {
    assert.throws(() => assertOwner({ ...ownerContext, [key]: "unapproved" }), /exact manual signing branch/);
  }
});

test("only follows the GitHub release CDN and verifies the complete pinned body and x86 machine", async () => {
  const bytes = Buffer.alloc(70);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(0x14c, 68);
  const pin = { url: canonicalUrl, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const hit = [];
  const result = await downloadPinned(pin, async (url, options) => {
    hit.push(String(url));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    return hit.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/test" } })
      : new Response(bytes);
  });
  assert.equal(hit.length, 2);
  assert.deepEqual(result, bytes);
  const privateBytes = await downloadPinned(pin, async (url, options) => {
    assert.equal(String(url), "https://release-assets.githubusercontent.com/private-test");
    assert.equal(options.headers, undefined);
    return new Response(bytes);
  }, new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/private-test" } }));
  assert.deepEqual(privateBytes, bytes);
  assert.doesNotThrow(() => assertX86(result));
  await assert.rejects(downloadPinned(pin, async () => new Response(null, { status: 302, headers: { location: "https://example.com/foreign" } })), /outside/);
  await assert.rejects(downloadPinned(pin, async () => new Response(Buffer.alloc(70))), /SHA-256/);
  bytes.writeUInt16LE(0x8664, 68);
  assert.throws(() => assertX86(bytes), /x86/);
});

test("keeps every canonical field except the x86 file leaf and verifies mandatory legacy V2 in exact stock 120", () => {
  const canonical = canonicalFixture();
  const output = mergeLegacyManifest(parser, canonical, signer.publicKey, signer.privateKey, signer.publicKey);
  assert.deepEqual({ ...output, agentFileUpdates: { ...output.agentFileUpdates, x86: canonical.agentFileUpdates.x86 } }, canonical);
  const leaf = output.agentFileUpdates.x86;
  const expected = stockValidate(output, signer.publicKey);
  assert.equal(expected.downloadUrl, bridge.url);
  assert.equal(expected.checksum, bridge.sha256);
  assert.equal(expected.latestVersion, "0.1.123");
  assert.equal(expected.forceUpdate, false);
  assert.equal(Object.hasOwn(leaf, "installerArgs"), false);
  for (const signature of ["signature", "signatureV2"]) {
    const changed = structuredClone(output);
    delete changed.agentFileUpdates.x86[signature];
    assert.throws(() => stockValidate(changed, signer.publicKey), /signature.*required/);
  }
  const different = generateKeyPairSync("ed25519");
  assert.throws(() => mergeLegacyManifest(parser, canonical, signer.publicKey, different.privateKey, signer.publicKey), /signature verification failed/);
  const modern = structuredClone(output);
  modern.agentFileUpdates.x86.signatureV2 = sign(null,
    Buffer.from(parser.buildProductionUpdateSignaturePayloadV2({ ...expected, arch: "x86" }) + '\ninstallerArgs=["/S","/UPDATE"]'),
    signer.privateKey).toString("base64");
  assert.throws(() => stockValidate(modern, signer.publicKey), /v2 signature verification failed/);
});

test("requires the exact unpublished GitHub inventory before and after a draft-only write", () => {
  const release = {
    id: draft.id, tag_name: draft.tag, target_commitish: draft.revision,
    draft: true, prerelease: true, published_at: null,
    assets: [{ id: draft.assetId, name: assetName, state: "uploaded",
      size: bridge.size, digest: "sha256:" + bridge.sha256 }],
  };
  assert.doesNotThrow(() => assertDraft(release));
  for (const change of [
    { id: 1 }, { tag_name: "v0.1.123" }, { target_commitish: "main" },
    { draft: false }, { prerelease: false }, { published_at: "2026-11-24" },
  ]) {
    assert.throws(() => assertDraft({ ...release, ...change }), /approved unpublished draft/);
  }
  for (const change of [{ id: 1 }, { digest: "sha256:other" }, { size: 70 }, { state: "new" }]) {
    assert.throws(() => assertDraft({ ...release, assets: [{ ...release.assets[0], ...change }] }), /approved asset/);
  }
  const body = Buffer.from(JSON.stringify(canonicalFixture()));
  const asset = { id: 99, name: "wonremote-update-manifest.json", state: "uploaded", size: body.length,
    digest: "sha256:" + createHash("sha256").update(body).digest("hex") };
  const written = { ...release, assets: [...release.assets, asset] };
  assert.throws(() => assertDraft(written), /draft asset inventory/);
  assert.doesNotThrow(() => assertDraft(written, asset, body));
  assert.throws(() => assertDraft(written, { ...asset, id: 100 }, body), /verified bytes/);
  assert.throws(() => assertDraft(written, asset, Buffer.from("changed")), /verified bytes/);
});
