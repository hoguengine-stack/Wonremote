import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { regressionReviewErrors, verifyRegressionReview } from "./verify-regression-review.js";
import { worktreeValidationErrors } from "./verify-recurrence-coverage.js";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const ordinary = { kind: "non-regression", reason: "Add a new process gate without repairing product behavior." };
const regression = {
  kind: "regression", reason: "Keyboard stopped working after updating the Viewer.",
  baselineRevision: "a".repeat(40), currentRevision: "b".repeat(40), files: ["input.js"],
  baselineEvidence: "The same keyboard sequence worked on the earlier installed Viewer.",
  findings: "The input handler changed from forwarding keys to dropping modifiers.",
  rootCause: "The new modifier filter drops Ctrl before forwarding the letter.",
  verification: "After reverting that filter the same input sequence succeeds.",
  prevention: "The existing input test now checks modifier forwarding on this path.",
};

test("classification is required; non-regression needs a concrete reason", () => {
  assert.ok(regressionReviewErrors(undefined).length);
  assert.ok(regressionReviewErrors({ kind: "other", reason: ordinary.reason }).length);
  assert.ok(regressionReviewErrors({ ...ordinary, reason: "pending evidence" }).length);
  assert.deepEqual(regressionReviewErrors(ordinary), []);
  assert.deepEqual(regressionReviewErrors(regression), []);
});

test("every comparison and resolution field is mandatory", () => {
  for (const key of Object.keys(regression)) {
    const missing = { ...regression };
    delete missing[key];
    assert.ok(regressionReviewErrors(missing).length, key);
  }
  for (const files of [[], ["../input.js"], ["C:/input.js"], ["/input.js"], [null]]) {
    assert.ok(regressionReviewErrors({ ...regression, files }).length);
  }
  assert.ok(regressionReviewErrors({ ...regression, currentRevision: regression.baselineRevision }).length);
});

test("completion and predeploy both reject missing review", () => {
  for (const stage of ["complete", "predeploy"]) {
    const errors = worktreeValidationErrors({ outcomes: [] }, [], "", stage);
    assert.ok(errors.includes("regressionReview.kind must be regression or non-regression"));
  }
});

test("real Git and CLI reject invented comparisons and exit nonzero", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wonremote-regression-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Gate test");
    git("config", "user.email", "gate@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", path.join(root, "no-hooks"));
    writeFileSync(path.join(root, "input.js"), "forwardModifiers();\n");
    git("add", "input.js"); git("commit", "--quiet", "-m", "Baseline");
    const baselineRevision = git("rev-parse", "HEAD");
    writeFileSync(path.join(root, "input.js"), "dropModifiers();\n");
    git("add", "input.js"); git("commit", "--quiet", "-m", "Changed behavior");
    const currentRevision = git("rev-parse", "HEAD");
    const review = { ...regression, baselineRevision, currentRevision };
    assert.doesNotThrow(() => verifyRegressionReview({ regressionReview: review }, root));
    assert.throws(() => verifyRegressionReview({ regressionReview: { ...review, baselineRevision: "0".repeat(40) } }, root), /Git comparison failed/);
    assert.throws(() => verifyRegressionReview({ regressionReview: { ...review, files: ["unrelated.js"] } }, root), /absent from the actual Git diff/);
    git("checkout", "--quiet", "--detach", baselineRevision);
    assert.throws(() => verifyRegressionReview({ regressionReview: review }, root), /Git comparison failed/);
    git("checkout", "--quiet", "--detach", currentRevision);
    const dir = path.join(root, "aether-link-app", "scripts");
    mkdirSync(dir, { recursive: true });
    copyFileSync(path.join(scripts, "verify-regression-review.js"), path.join(dir, "verify-regression-review.js"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const cli = (value) => {
      writeFileSync(path.join(root, "CHANGE_CONTRACT.json"), JSON.stringify(value));
      return spawnSync(process.execPath, [path.join(dir, "verify-regression-review.js")], { encoding: "utf8", windowsHide: true });
    };
    assert.equal(cli({ regressionReview: review }).status, 0);
    assert.equal(cli({ regressionReview: ordinary }).status, 0);
    for (const value of [{}, { regressionReview: { ...review, findings: "pending" } },
      { regressionReview: { ...review, files: ["unrelated.js"] } }]) {
      const result = cli(value);
      assert.equal(result.status, 1, result.stdout + result.stderr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CI prerequisite runs the executable tests before the release job", () => {
  const workflow = readFileSync(path.resolve(scripts, "../../.github/workflows/publish-release.yml"), "utf8");
  const guard = workflow.slice(workflow.indexOf("  change-guard:"), workflow.indexOf("  build-release:"));
  assert.match(guard, /node --test aether-link-app\/scripts\/verify-regression-review.test.mjs/);
  assert.match(guard, /node aether-link-app\/scripts\/verify-recurrence-coverage.js/);
  assert.match(workflow, /build-release:\s+needs: change-guard/);
});
