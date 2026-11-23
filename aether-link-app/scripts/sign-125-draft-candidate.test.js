import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { signDraftCandidate } from "./sign-125-draft-candidate.js";

const ownerContext = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "hoguengine-stack/Wonremote",
  GITHUB_REPOSITORY_ID: "1136941328",
  GITHUB_REF: "refs/heads/codex/sign-wonremote-125-draft",
  GITHUB_ACTOR: "hoguengine-stack",
  GITHUB_ACTOR_ID: "246740147",
  GITHUB_TRIGGERING_ACTOR: "hoguengine-stack",
  GH_TOKEN: "fixture-only",
};
const manifestName = "wonremote-update-manifest.json";

function makeFixture() {
  const names = [
    "WonRemote-Viewer-Setup.exe",
    "WonRemote-Agent-Setup.exe",
    "WonRemote-Agent-Update.exe",
  ];
  const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
  const bytes = names.map((_, index) => {
    const image = Buffer.alloc(71);
    image.write("MZ");
    image.writeUInt32LE(64, 60);
    image.write("PE\0\0", 64, "binary");
    image.writeUInt16LE(0x014c, 68);
    image[70] = index;
    return image;
  });
  const pins = {
    id: 101,
    tag: "internal-wonremote-125-12345678901234567890123456789012",
    assets: Object.fromEntries(names.map((name, index) => [
      name, { size: bytes[index].length, sha256: sha256(bytes[index]) },
    ])),
  };
  const release = {
    id: pins.id,
    draft: true,
    published_at: null,
    tag_name: pins.tag,
    assets: names.map((name, index) => ({
      id: 200 + index,
      name,
      state: "uploaded",
      size: pins.assets[name].size,
      digest: "sha256:" + pins.assets[name].sha256,
    })),
  };
  const requests = [];
  let signed = 0;
  const files = [];
  const fetchRequest = async (url, options) => {
    const parsed = new URL(url);
    requests.push([options.method, parsed.hostname, parsed.pathname]);
    const resources = "/repos/hoguengine-stack/Wonremote/releases/";
    if (parsed.hostname === "api.github.com" && parsed.pathname === resources + pins.id) {
      return Response.json(release);
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith(resources + "assets/")) {
      const index = Number(parsed.pathname.split("/").at(-1)) - 200;
      return new Response(bytes[index]);
    }
    assert.equal(parsed.hostname, "uploads.github.com");
    assert.equal(parsed.pathname, resources + pins.id + "/assets");
    assert.equal(parsed.searchParams.get("name"), manifestName);
    const uploaded = {
      id: 222,
      name: manifestName,
      size: options.body.length,
      state: "uploaded",
      digest: "sha256:" + sha256(options.body),
    };
    release.assets.push(uploaded);
    return Response.json(uploaded, { status: 201 });
  };
  const signAndVerify = ({ paths, manifestPath }) => {
    signed++;
    files.push(...paths, manifestPath);
    assert.deepEqual(paths.map(file => fs.readFileSync(file)), bytes);
    fs.writeFileSync(manifestPath, '{"fixture":"signed and verified"}');
  };
  return {
    context: { ...ownerContext }, pins, bytes, release, requests, files, fetchRequest, signAndVerify,
    signed: () => signed,
  };
}

test("requires original owner, internal draft tag, and final approved pins before any request", async () => {
  const replay = makeFixture();
  replay.context.GITHUB_TRIGGERING_ACTOR = "other";
  await assert.rejects(signDraftCandidate(replay), /owner/);
  assert.deepEqual(replay.requests, []);

  const incomplete = makeFixture();
  incomplete.pins.assets["WonRemote-Agent-Update.exe"].sha256 = "";
  await assert.rejects(signDraftCandidate(incomplete), /pins/);
  assert.deepEqual(incomplete.requests, []);
});

test("rejects public drafts and substituted bytes before sign or upload", async () => {
  const publicRelease = makeFixture();
  publicRelease.release.published_at = "2026-11-23T00:00:00Z";
  await assert.rejects(signDraftCandidate(publicRelease), /unpublished/);
  assert.equal(publicRelease.requests.length, 1);
  assert.equal(publicRelease.signed(), 0);

  const altered = makeFixture();
  altered.bytes[2][70] = 90;
  await assert.rejects(signDraftCandidate(altered), /bytes/);
  assert.equal(altered.requests.length, 4);
  assert.equal(altered.signed(), 0);
});

test("uploads only to the same draft after verification and a second read; closes temporary files", async () => {
  const fixture = makeFixture();
  await signDraftCandidate(fixture);
  assert.equal(fixture.signed(), 1);
  assert.deepEqual(fixture.requests.map(items => items[0]), ["GET", "GET", "GET", "GET", "GET", "POST", "GET"]);
  assert.equal(fixture.requests[0][2], fixture.requests[4][2]);
  assert.equal(fixture.requests[0][2], fixture.requests[6][2]);
  assert.match(fixture.requests[5][2], /\/releases\/101\/assets$/);
  assert.equal(fixture.files.every(file => !fs.existsSync(file)), true);
});

test("a draft published during verification rejects before manifest upload", async () => {
  const fixture = makeFixture();
  await assert.rejects(signDraftCandidate({
    ...fixture,
    signAndVerify(args) {
      fixture.signAndVerify(args);
      fixture.release.draft = false;
    },
  }), /unpublished/);
  assert.equal(fixture.signed(), 1);
  assert.deepEqual(fixture.requests.map(item => item[0]), Array(5).fill("GET"));
  assert.equal(fixture.files.every(file => !fs.existsSync(file)), true);
});

test("the real manifest verifier refuses a temporary key despite its matching override", async () => {
  const fixture = makeFixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fixture.context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" });
  fixture.context.WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = publicKey.export({ format: "pem", type: "spki" });
  await assert.rejects(signDraftCandidate({ ...fixture, signAndVerify: undefined }), /bundled operating-key/);
  assert.deepEqual(fixture.requests.map(item => item[0]), Array(4).fill("GET"));
});
