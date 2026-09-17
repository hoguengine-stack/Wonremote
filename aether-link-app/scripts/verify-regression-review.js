import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = (value) => typeof value === "string" && value.trim().length >= 12
  && !/^(pending|tbd|todo|not[ -]?run|none|n\/a|unknown)\b/i.test(value.trim());

export function regressionReviewErrors(review) {
  const errors = [];
  if (!["regression", "non-regression"].includes(review?.kind)) {
    errors.push("regressionReview.kind must be regression or non-regression");
  }
  if (!evidence(review?.reason)) errors.push("regressionReview.reason requires concrete evidence");
  if (review?.kind !== "regression") return errors;
  for (const field of ["baselineEvidence", "findings", "rootCause", "verification", "prevention"]) {
    if (!evidence(review[field])) errors.push(`regressionReview.${field} requires concrete evidence`);
  }
  for (const field of ["baselineRevision", "currentRevision"]) {
    if (typeof review[field] !== "string" || !/^[a-f0-9]{40}$/.test(review[field])) {
      errors.push(`regressionReview.${field} must be a full Git commit hash`);
    }
  }
  if (review.baselineRevision === review.currentRevision) errors.push("regression comparison revisions must differ");
  if (!Array.isArray(review.files) || review.files.length === 0 || review.files.some((file) =>
    typeof file !== "string" || !file.trim() || file.includes("\\") || file.startsWith("/")
    || file.split("/").some((part) => ["..", ".", ""].includes(part)) || /^[a-z]:/i.test(file))) {
    errors.push("regressionReview.files must name repository-relative compared files");
  }
  return errors;
}

export function verifyRegressionReview(contract, root = repositoryRoot) {
  const review = contract.regressionReview;
  const errors = regressionReviewErrors(review);
  if (errors.length) throw new Error(errors.join("\n"));
  if (review.kind !== "regression") return;
  const git = (args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    for (const revision of [review.baselineRevision, review.currentRevision]) {
      git(["cat-file", "-e", `${revision}^{commit}`]);
    }
    git(["merge-base", "--is-ancestor", review.currentRevision, "HEAD"]);
    const files = new Set();
    // NUL separation preserves spaces and non-ASCII filenames without Git quoting.
    for (const file of git(["diff", "--name-only", "--no-renames", "-z", review.baselineRevision, review.currentRevision, "--"]).split("\0")) {
      if (file) files.add(file);
    }
    if (!review.files.every((file) => files.has(file))) {
      throw new Error("claimed comparison files are absent from the actual Git diff");
    }
  } catch (error) {
    throw new Error(`Regression Git comparison failed: ${error.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyRegressionReview(JSON.parse(readFileSync(path.join(repositoryRoot, "CHANGE_CONTRACT.json"), "utf8")));
    console.log("Regression comparison gate passed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
