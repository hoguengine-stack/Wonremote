import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { worktreeValidationErrors } from "./verify-recurrence-coverage.js";
import { signDraftCandidate } from "./sign-compat124-draft-candidate.js";
import { makeCommon124, verifyCommon124 } from "./common124-manifest.mjs";

const ownerContext = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "hoguengine-stack/Wonremote",
  GITHUB_REPOSITORY_ID: "1136941328",
  GITHUB_REF: "refs/heads/codex/sign-wonremote-compat124-draft-8a21cfce",
  GITHUB_ACTOR: "hoguengine-stack",
  GITHUB_ACTOR_ID: "246740147",
  GITHUB_TRIGGERING_ACTOR: "hoguengine-stack",
  GH_TOKEN: "fixture-only",
};
const manifestName = "wonremote-update-manifest.json";

function makeFixture() {
  const names = ["WonRemote-Agent-Update.exe"];
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
    tag: "internal-wonremote-agent123-compat-124-1234567890123456",
    targetCommitish: "a".repeat(40),
    assets: Object.fromEntries(names.map((name, index) => [
      name, { id: 200 + index, size: bytes[index].length, sha256: sha256(bytes[index]) },
    ])),
  };
  const release = {
    id: pins.id,
    draft: true,
    published_at: null,
    tag_name: pins.tag,
    target_commitish: pins.targetCommitish,
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

test("approved signing cannot read another draft", async () => {
  const calls = [];
  await assert.rejects(signDraftCandidate({
    context: ownerContext,
    fetchRequest: async (url) => {
      calls.push(url);
      return new Response(null, { status: 404 });
    },
  }), /Reading the approved draft metadata failed/);
  assert.deepEqual(calls, ["https://api.github.com/repos/hoguengine-stack/Wonremote/releases/460431429"]);
});

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
  altered.bytes[0][70] = 90;
  await assert.rejects(signDraftCandidate(altered), /bytes/);
  assert.equal(altered.requests.length, 2);
  assert.equal(altered.signed(), 0);
});

test("uploads only to the same draft after verification and a second read; closes temporary files", async () => {
  const fixture = makeFixture();
  await signDraftCandidate(fixture);
  assert.equal(fixture.signed(), 1);
  assert.deepEqual(fixture.requests.map(items => items[0]), ["GET", "GET", "GET", "POST", "GET"]);
  assert.equal(fixture.requests[0][2], fixture.requests[2][2]);
  assert.equal(fixture.requests[0][2], fixture.requests[4][2]);
  assert.match(fixture.requests[3][2], /\/releases\/101\/assets$/);
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
  assert.deepEqual(fixture.requests.map(item => item[0]), Array(3).fill("GET"));
  assert.equal(fixture.files.every(file => !fs.existsSync(file)), true);
});

test("the real manifest verifier refuses a temporary key despite its matching override", async () => {
  const fixture = makeFixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fixture.context.WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" });
  fixture.context.WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = publicKey.export({ format: "pem", type: "spki" });
  await assert.rejects(signDraftCandidate({ ...fixture, signAndVerify: undefined }), /bundled operating-key/);
  assert.deepEqual(fixture.requests.map(item => item[0]), Array(2).fill("GET"));
});

test("the signing qualification preserves earlier completed proof and still requires the new Windows trial", () => {
  const path = "aether-link-app/scripts/sign-compat124-draft-candidate.test.js";
  const previous = {
    id: "prior-installed",
    acceptance: "Earlier Agent installed on its approved local PC",
    boundaries: ["existing installation proof"],
    proofLevel: "physical-completed",
    verification: "Prior installed ID and health observed",
    physicalGap: "none",
    contractTests: [path],
  };
  const pending = {
    ...previous,
    id: "candidate-installed",
    acceptance: "Fresh approved candidate runs after upgrade",
    proofLevel: "physical-required",
    verification: "pending",
    physicalGap: "Both 123 variants still require an installed 124 trial, fresh screen and Windows input.",
  };
  const contract = {
    status: "active", intent: "Owner-only candidate signing",
    changeType: "build", risk: "high", releaseImpact: "build",
    requestReview: { impact: "none", reason: "No device or Viewer traffic." },
    regressionReview: { kind: "non-regression", reason: "Packaging qualification only." },
    rollback: "Discard the isolated unsigned candidate.",
    outcomes: [previous, pending],
  };
  assert.deepEqual(worktreeValidationErrors(contract, [path], "", "qualification"), []);
  const publicationErrors = worktreeValidationErrors({ ...contract, status: "ready-to-deploy" }, [path], "", "predeploy");
  assert.ok(publicationErrors.includes("outcomes[1] still requires physical proof"));
});

test("same-shape asset ID substitution and draft-base substitution reject before signing", async () => {
  for (const mutate of [release => { release.assets[0].id++; }, release => { release.target_commitish = "b".repeat(40); }]) {
    const fixture = makeFixture();
    mutate(fixture.release);
    await assert.rejects(signDraftCandidate(fixture), /pin|unpublished/);
    assert.equal(fixture.signed(), 0);
    assert.equal(fixture.requests.length, 1);
  }
});

test("signs exactly one x86 leaf and refuses added arguments or a second asset", async () => {
  const fixture = makeFixture();
  const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: {format: "pem", type: "pkcs8"}, publicKeyEncoding: {format: "pem", type: "spki"} });
  await signDraftCandidate({ ...fixture, signAndVerify({ paths: [file], manifestPath, pins }) {
    const expected = { tag: pins.tag, checksum: pins.assets["WonRemote-Agent-Update.exe"].sha256 };
    const manifest = makeCommon124({ ...keys, pins: expected, file });
    assert.deepEqual(Object.keys(manifest).sort(), ["agentFileUpdates", "forceUpdate", "version"]);
    assert.deepEqual(Object.keys(manifest.agentFileUpdates), ["x86"]);
    assert.equal(manifest.agentFileUpdates.x86.installerArgs, undefined);
    assert.throws(() => verifyCommon124({ ...manifest, agentWindows: {} }, expected, keys.publicKey));
    assert.throws(() => verifyCommon124({ ...manifest, agentFileUpdates: { x86: { ...manifest.agentFileUpdates.x86, installerArgs: ["/S"] }}}, expected, keys.publicKey));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx" });
  }});
  assert.equal(fixture.requests.filter(([method]) => method === "POST").length, 1);
});
