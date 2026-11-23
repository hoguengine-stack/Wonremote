import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { signBridgeDraft } from "./sign-120-bridge-draft.js";

const ownerContext = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "hoguengine-stack/Wonremote",
  GITHUB_REPOSITORY_ID: "1136941328",
  GITHUB_REF: "refs/heads/codex/sign-wonremote-120-bridge-123",
  GITHUB_ACTOR: "hoguengine-stack",
  GITHUB_ACTOR_ID: "246740147",
  GITHUB_TRIGGERING_ACTOR: "hoguengine-stack",
  GH_TOKEN: "fixture-only",
};
const tag = "internal-wonremote-agent120-bridge123-20261123";
const manifestName = "wonremote-update-manifest.json";
const bridgeName = "WonRemote-Agent-Update.exe";
const releaseBase = "https://github.com/hoguengine-stack/Wonremote/releases/download/";
const resources = "/repos/hoguengine-stack/Wonremote/releases/";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function image(index) {
  const bytes = Buffer.alloc(71);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(0x014c, 68);
  bytes[70] = index;
  return bytes;
}

function makeFixture() {
  const bridge = image(0);
  const sidecarBytes = [image(1), image(2)];
  const sidecars = ["WonRemote-Viewer-Setup.exe", "WonRemote-Agent-Setup.exe"].map((name, index) => ({
    name,
    size: sidecarBytes[index].length,
    sha256: sha256(sidecarBytes[index]),
  }));
  const pins = { id: 101, tag, size: bridge.length, sha256: sha256(bridge) };
  const release = {
    id: pins.id, draft: true, published_at: null, tag_name: tag,
    assets: [{id: 201, name: bridgeName, state: "uploaded", size: pins.size, digest: "sha256:" + pins.sha256}],
  };
  const requests = [];
  const files = [];
  let posted;
  let signed = 0;
  const fetchRequest = async (url, options) => {
    const parsed = new URL(url);
    requests.push([options.method, parsed.hostname, parsed.pathname]);
    if (parsed.hostname === "github.com") {
      assert.equal(options.headers, undefined);
      const index = sidecars.findIndex(pin => parsed.href === releaseBase + "v0.1.123/" + pin.name);
      assert.notEqual(index, -1);
      return new Response(sidecarBytes[index]);
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === resources + pins.id) {
      return Response.json(release);
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === resources + "assets/201") {
      return new Response(bridge);
    }
    assert.equal(parsed.hostname, "uploads.github.com");
    assert.equal(parsed.pathname, resources + pins.id + "/assets");
    assert.equal(parsed.searchParams.get("name"), manifestName);
    posted = JSON.parse(options.body.toString("utf8"));
    const uploaded = { id: 222, name: manifestName, size: options.body.length, state: "uploaded", digest: "sha256:" + sha256(options.body) };
    release.assets.push(uploaded);
    return Response.json(uploaded, { status: 201 });
  };
  const signAndVerify = ({ paths, manifestPath }) => {
    signed++;
    files.push(...paths, manifestPath);
    assert.deepEqual(paths.map(file => fs.readFileSync(file)), [...sidecarBytes, bridge]);
    const asset = {
      name: bridgeName, url: releaseBase + tag + "/" + bridgeName, sha256: pins.sha256,
      installerArgs: ["/S", "/UPDATE"], signature: "AAAA", signatureV2: "BBBB",
    };
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: "0.1.123", forceUpdate: false, viewerWindows: {}, agentInstallers: {}, agentFileUpdates: { x64: asset, x86: asset },
    }));
  };
  return {
    context: { ...ownerContext }, pins, sidecars, bridge, sidecarBytes, release, requests, files, fetchRequest, signAndVerify,
    posted: () => posted, signed: () => signed,
  };
}

test("requires the exact owner branch, fixed unpublished tag and final pins before a request", async () => {
  for (const [override, pattern] of [
    [{ context: { ...ownerContext, GITHUB_ACTOR_ID: "4" } }, /owner/],
    [{ context: { ...ownerContext, GITHUB_REF: "refs/heads/codex/sign-wonremote-124-draft" } }, /branch/],
    [{ pins: { ...makeFixture().pins, tag: "v0.1.123" } }, /pins/],
    [{ pins: { ...makeFixture().pins, id: 0 } }, /pins/],
  ]) {
    const fixture = makeFixture();
    await assert.rejects(signBridgeDraft({ ...fixture, ...override }), pattern);
    assert.deepEqual(fixture.requests, []);
  }
});

test("the configured unpublished release and installer pins match the approved bridge", async () => {
  const installerHash = "d4b0e341a00bb039eba2c3a08acf8416c4aa0f721b82ca0c0f26778b05ceea2f";
  const urls = [];
  await assert.rejects(signBridgeDraft({
    context: ownerContext,
    fetchRequest(url) {
      urls.push(new URL(url).pathname);
      if (urls.length === 1) {
        return Response.json({
          id: 455731614, draft: true, published_at: null, tag_name: tag,
          assets: [{
            id: 201, name: bridgeName, state: "uploaded", size: 29690013,
            digest: "sha256:" + installerHash,
          }],
        });
      }
      return new Response(null, { status: 404 });
    },
  }), /pinned installer failed/);
  assert.deepEqual(urls, [resources + "455731614", resources + "assets/201"]);
});

test("rejects a public or mixed release and substituted private or public bytes before signing", async () => {
  const publicRelease = makeFixture();
  publicRelease.release.published_at = "2026-11-23T00:00:00Z";
  await assert.rejects(signBridgeDraft(publicRelease), /unpublished/);
  const mixedRelease = makeFixture();
  mixedRelease.release.assets.push({ name: "extra" });
  await assert.rejects(signBridgeDraft(mixedRelease), /inventory/);
  const bridge = makeFixture();
  bridge.bridge[70] = 9;
  await assert.rejects(signBridgeDraft(bridge), /bytes/);
  const sidecar = makeFixture();
  sidecar.sidecarBytes[1][70] = 9;
  await assert.rejects(signBridgeDraft(sidecar), /bytes/);
  for (const fixture of [publicRelease, mixedRelease, bridge, sidecar]) {
    assert.equal(fixture.signed(), 0);
    assert.equal(fixture.requests.some(([method]) => method === "POST"), false);
  }
});

test("uploads only the one x86 bridge entry, after rereading the same draft", async () => {
  const fixture = makeFixture();
  await signBridgeDraft(fixture);
  assert.equal(fixture.signed(), 1);
  assert.deepEqual(fixture.requests.map(([method]) => method), ["GET", "GET", "GET", "GET", "GET", "POST", "GET"]);
  assert.equal(fixture.requests[0][2], fixture.requests[4][2]);
  assert.equal(fixture.requests[0][2], fixture.requests[6][2]);
  assert.equal(fixture.requests[5][2], resources + "101/assets");
  assert.deepEqual(Object.keys(fixture.posted()), ["version", "forceUpdate", "agentFileUpdates"]);
  assert.deepEqual(Object.keys(fixture.posted().agentFileUpdates), ["x86"]);
  assert.equal(fixture.posted().agentFileUpdates.x86.sha256, fixture.pins.sha256);
  assert.equal(fixture.files.every(file => !fs.existsSync(file)), true);
});

test("an unexpected CDN redirect is rejected without sending credentials or signing", async () => {
  const fixture = makeFixture();
  await assert.rejects(signBridgeDraft({
    ...fixture,
    fetchRequest(url, options) {
      if (String(url).endsWith("assets/201")) return Response.redirect("https://www.example.com/asset");
      return fixture.fetchRequest(url, options);
    },
  }), /release CDN/);
  assert.equal(fixture.signed(), 0);
  assert.deepEqual(fixture.requests.map(([, host]) => host), ["api.github.com"]);
});

test("publication, a changed asset ID, or an incorrect signed argument blocks upload", async () => {
  for (const [mutate, pattern] of [
    [(fixture) => { fixture.release.draft = false; }, /unpublished/],
    [(fixture) => { fixture.release.assets[0].id = 202; }, /changed during signing/],
    [(_fixture, args) => {
      const manifest = JSON.parse(fs.readFileSync(args.manifestPath, "utf8"));
      delete manifest.agentFileUpdates.x86.installerArgs;
      fs.writeFileSync(args.manifestPath, JSON.stringify(manifest));
    }, /signed installer argument policy/],
  ]) {
    const fixture = makeFixture();
    await assert.rejects(signBridgeDraft({
      ...fixture,
      signAndVerify(args) {
        fixture.signAndVerify(args);
        mutate(fixture, args);
      },
    }), pattern);
    assert.equal(fixture.requests.some(([method]) => method === "POST"), false);
    assert.equal(fixture.files.every(file => !fs.existsSync(file)), true);
  }
});

test("the real verifier refuses a temporary signing key despite its matching context override", async () => {
  const fixture = makeFixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fixture.context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" });
  fixture.context.WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = publicKey.export({ format: "pem", type: "spki" });
  await assert.rejects(signBridgeDraft({ ...fixture, signAndVerify: undefined }), /bundled operating-key/);
  assert.deepEqual(fixture.requests.map(([method]) => method), Array(4).fill("GET"));
});
