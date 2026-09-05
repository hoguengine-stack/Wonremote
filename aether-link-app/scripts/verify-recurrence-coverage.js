import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "..");
const registryPath = path.join(repositoryRoot, "INCIDENT_REGISTRY.md");
const changeContractPath = path.join(repositoryRoot, "CHANGE_CONTRACT.json");

export const DEVELOPMENT_POLICY_BASE = "84873c9be133e8252042153d94c4e54c14caca14";

export const INCIDENT_COMMIT_PATTERN = /^(?:Fix|Retry|Repair|Prevent|Recover)\b|^(?:Harden|Align|Prepare|Split|Limit|Reduce|Speed up|Keep)\b.*\b(?:failure|update|release|installer|runtime|WebRTC|Agent|regression|resource|build|publication|cache)\b/i;
const REQUIRED_INCIDENT_FIELDS = [
  "Detected", "Severity", "Affected", "Status", "User-visible symptom", "Minimal trigger",
  "Root cause and contributors", "Fix commit(s)", "Permanent guard", "Regression proof",
  "Release proof", "Remaining blocker",
];
const REQUIRED_CHANGE_TRAILERS = [
  "Intent", "Change-Type", "Risk", "Acceptance", "Contract", "Proof-Level", "Verification",
  "Release-Impact", "Rollback", "Request-Review",
];
const CHANGE_TYPES = new Set(["feature", "fix", "refactor", "test", "build", "docs", "chore"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const RELEASE_IMPACTS = new Set(["none", "build", "deploy", "build-and-deploy"]);
const PROOF_LEVELS = new Set([
  "automated-runtime", "deployment-required", "physical-completed", "physical-required", "not-applicable",
]);
const FUNCTIONAL_CHANGE_TYPES = new Set(["feature", "fix", "refactor", "test", "build"]);
const TEST_PATH_PATTERN = /(?:\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|Test\.java|_test\.rs)$/i;

export function parseIncidentTrailer(body) {
  return body.match(/^Incident:\s*(INC-\d{8}-\d{3})\s*$/im)?.[1] ?? null;
}

export function findIncidentByFixCommit(hash, registry) {
  for (const match of registry.matchAll(/^## (INC-\d{8}-\d{3}):/gm)) {
    const start = match.index;
    const next = registry.indexOf("\n## ", start + match[0].length);
    const section = registry.slice(start, next < 0 ? registry.length : next);
    const fixLine = section.match(/^- Fix commit\(s\):\s*(.+)$/m)?.[1] ?? "";
    if ([...fixLine.matchAll(/\b[0-9a-f]{7,40}\b/gi)].some(([candidate]) =>
      hash.toLowerCase().startsWith(candidate.toLowerCase()),
    )) {
      return match[1];
    }
  }
  return null;
}

function parseTrailer(body, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`^${escapedName}:\\s*(\\S.*)$`, "im"))?.[1].trim() ?? null;
}

export function changeValidationErrors(commit, registry) {
  const values = Object.fromEntries(REQUIRED_CHANGE_TRAILERS.map((name) => [name, parseTrailer(commit.body, name)]));
  const errors = REQUIRED_CHANGE_TRAILERS.filter((name) => !values[name]).map((name) => `missing ${name} trailer`);
  const changeType = values["Change-Type"]?.toLowerCase();
  const risk = values.Risk?.toLowerCase();
  const releaseImpact = values["Release-Impact"]?.toLowerCase();
  const proofLevel = values["Proof-Level"]?.toLowerCase();

  if (changeType && !CHANGE_TYPES.has(changeType)) errors.push("invalid Change-Type trailer");
  if (risk && !RISK_LEVELS.has(risk)) errors.push("invalid Risk trailer");
  if (releaseImpact && !RELEASE_IMPACTS.has(releaseImpact)) errors.push("invalid Release-Impact trailer");
  if (proofLevel && !PROOF_LEVELS.has(proofLevel)) errors.push("invalid Proof-Level trailer");
  if (values["Request-Review"] && !/^(none|changed)\s+-\s+\S.+$/i.test(values["Request-Review"])) {
    errors.push("Request-Review must state none or changed followed by its reason/evidence");
  }

  for (const name of ["Intent", "Acceptance", "Contract", "Verification", "Rollback"]) {
    if (values[name] && /^(?:pending|tbd|todo|not[ -]?run)$/i.test(values[name])) {
      errors.push(`${name} trailer cannot be pending`);
    }
  }

  if (changeType && FUNCTIONAL_CHANGE_TYPES.has(changeType)) {
    if (proofLevel === "not-applicable") errors.push("functional change requires an observable proof level");
    const contractPaths = (values.Contract ?? "").split(",").map((value) => value.trim().replaceAll("\\", "/"))
      .filter((value) => TEST_PATH_PATTERN.test(value));
    if (contractPaths.length === 0) {
      errors.push("functional change Contract must name a test file");
    } else {
      const changedFiles = new Set((commit.files ?? []).map((value) => value.replaceAll("\\", "/")));
      if (!contractPaths.some((value) => changedFiles.has(value))) {
        errors.push("functional change Contract must name a test changed with the implementation");
      }
    }
  }

  if (changeType === "fix") {
    const incident = parseIncidentTrailer(commit.body);
    if (!incident) {
      errors.push("fix requires Incident trailer");
    } else {
      errors.push(...incidentValidationErrors(incident, registry).map((error) => `Incident ${incident}: ${error}`));
    }
  }
  return errors;
}

export function worktreeValidationErrors(contract, changedFiles, registry, stage = "complete") {
  const errors = requestReviewErrors(contract.requestReview, changedFiles);
  const changed = new Set(changedFiles.map((value) => value.replaceAll("\\", "/")));
  const changeType = String(contract.changeType ?? "").toLowerCase();

  const expectedStatus = stage === "predeploy" ? "ready-to-deploy" : "verified";
  if (contract.status !== expectedStatus) {
    errors.push(`CHANGE_CONTRACT.json status must be ${expectedStatus} for ${stage}`);
  }
  if (!String(contract.intent ?? "").trim()) errors.push("CHANGE_CONTRACT.json intent is required");
  if (!CHANGE_TYPES.has(changeType)) errors.push("CHANGE_CONTRACT.json changeType is invalid");
  if (!RISK_LEVELS.has(String(contract.risk ?? "").toLowerCase())) errors.push("CHANGE_CONTRACT.json risk is invalid");
  if (!RELEASE_IMPACTS.has(String(contract.releaseImpact ?? "").toLowerCase())) {
    errors.push("CHANGE_CONTRACT.json releaseImpact is invalid");
  }
  if (!String(contract.rollback ?? "").trim()) errors.push("CHANGE_CONTRACT.json rollback is required");
  if (changeType === "fix" && incidentValidationErrors(String(contract.incident ?? ""), registry).length > 0) {
    errors.push("CHANGE_CONTRACT.json fix must reference a complete incident");
  }

  if (!Array.isArray(contract.outcomes) || contract.outcomes.length === 0) {
    errors.push("CHANGE_CONTRACT.json requires one outcome per user-requested result");
    return errors;
  }

  const outcomeIds = new Set();
  for (const [index, outcome] of contract.outcomes.entries()) {
    const label = `outcomes[${index}]`;
    const id = String(outcome?.id ?? "").trim();
    if (!id) errors.push(`${label}.id is required`);
    if (outcomeIds.has(id)) errors.push(`${label}.id must be unique`);
    outcomeIds.add(id);
    if (!String(outcome?.acceptance ?? "").trim()) errors.push(`${label}.acceptance is required`);
    if (!Array.isArray(outcome?.boundaries) || outcome.boundaries.length === 0) {
      errors.push(`${label}.boundaries must describe the complete user path`);
    }
    const proofLevel = String(outcome?.proofLevel ?? "").toLowerCase();
    if (!PROOF_LEVELS.has(proofLevel) || proofLevel === "not-applicable") {
      errors.push(`${label}.proofLevel must prove a functional outcome`);
    }
    const verificationPending = !String(outcome?.verification ?? "").trim()
      || /^(?:pending|tbd|todo|not[ -]?run)$/i.test(outcome.verification);
    if (verificationPending && !(stage === "predeploy" && proofLevel === "deployment-required")) {
      errors.push(`${label}.verification must contain fresh evidence`);
    }
    if (!Array.isArray(outcome?.contractTests) || outcome.contractTests.length === 0) {
      errors.push(`${label}.contractTests must name a changed boundary test`);
    } else if (!outcome.contractTests.some((value) =>
      TEST_PATH_PATTERN.test(String(value)) && changed.has(String(value).replaceAll("\\", "/")),
    )) {
      errors.push(`${label}.contractTests must include a test changed with the implementation`);
    }
    if (proofLevel === "physical-required"
        && (!String(outcome?.physicalGap ?? "").trim() || /^none$/i.test(outcome.physicalGap))) {
      errors.push(`${label}.physicalGap must describe the remaining physical proof`);
    }
  }
  return errors;
}

export function requestReviewErrors(review, changedFiles) {
  const errors = [];
  const hasEvidence = (value) => typeof value === "string" && value.trim()
    && !/^(pending|tbd|todo|not[ -]?run)$/i.test(value.trim());
  if (!["none", "changed"].includes(review?.impact)) errors.push("requestReview.impact must be none or changed");
  if (!hasEvidence(review?.reason)) errors.push("requestReview.reason is required");
  if (review?.impact !== "changed") return errors;
  if (!hasEvidence(review.assumptions)) errors.push("requestReview.assumptions must define clients, documents, startup and reconnect costs");
  const budget = review.dailyBudget ?? {};
  const fields = ["clients", "readsPerClient", "writesPerClient", "maxReads", "maxWrites"];
  if (fields.some((key) => !Number.isFinite(budget[key]) || budget[key] < 0)
      || !Number.isInteger(budget.clients) || budget.clients < 1) {
    errors.push("requestReview.dailyBudget requires finite nonnegative counts and positive integer clients");
  } else if (budget.clients * budget.readsPerClient > budget.maxReads
      || budget.clients * budget.writesPerClient > budget.maxWrites) {
    errors.push("requestReview.dailyBudget exceeds its declared read/write limits");
  }
  for (const scenario of ["idle", "rerender", "concurrency", "failure", "cleanup"]) {
    if (!hasEvidence(review.checks?.[scenario])) errors.push(`requestReview.checks.${scenario} requires evidence`);
  }
  const changed = new Set(changedFiles.map((file) => file.replaceAll("\\", "/")));
  if (!Array.isArray(review.contractTests) || !review.contractTests.some((file) =>
    typeof file === "string" && TEST_PATH_PATTERN.test(file) && changed.has(file.replaceAll("\\", "/")),
  )) errors.push("requestReview.contractTests must name a changed request-boundary test");
  return errors;
}

export function findProcessViolations(commits, registry) {
  return commits.map((commit) => ({ ...commit, errors: changeValidationErrors(commit, registry) }))
    .filter(({ errors }) => errors.length > 0);
}

export function findUncoveredCommits(commits, registry) {
  return commits
    .filter(({ subject }) => INCIDENT_COMMIT_PATTERN.test(subject))
    .map((commit) => ({
      ...commit,
      incident: parseIncidentTrailer(commit.body) ?? findIncidentByFixCommit(commit.hash, registry),
    }))
    .filter(({ incident }) => !incident || incidentValidationErrors(incident, registry).length > 0);
}

export function incidentValidationErrors(incident, registry) {
  const heading = `## ${incident}:`;
  const start = registry.indexOf(heading);
  if (start < 0) return ["missing incident entry"];
  const next = registry.indexOf("\n## ", start + heading.length);
  const section = registry.slice(start, next < 0 ? registry.length : next);
  return REQUIRED_INCIDENT_FIELDS.filter((field) => {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^- ${escapedField}:\\s*\\S`, "m").test(section);
  });
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function resolveAuditBase() {
  if (process.env.WONREMOTE_RECURRENCE_BASE) {
    return process.env.WONREMOTE_RECURRENCE_BASE;
  }
  try {
    return git(["describe", "--tags", "--abbrev=0", "HEAD^"]);
  } catch {
    return git(["rev-list", "--max-parents=0", "HEAD"]);
  }
}

function readCommits(base) {
  const output = git(["log", `${base}..HEAD`, "--format=%H%x1f%s%x1f%b%x1e"]);
  if (!output) return [];
  return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash, subject, ...bodyParts] = record.split("\x1f");
    const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-filter=ACMR", hash])
      .split(/\r?\n/).filter(Boolean);
    return { hash, subject, body: bodyParts.join("\x1f"), files };
  });
}

function readWorkingTreeFiles() {
  const tracked = git(["diff", "--name-only", "HEAD"]);
  return tracked.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

const POST_DEPLOYMENT_PROOF_FILES = new Set(["CHANGE_CONTRACT.json", "INCIDENT_REGISTRY.md"]);

export function selectContractFiles(worktreeFiles, committedFiles) {
  const working = worktreeFiles.map((value) => value.replaceAll("\\", "/"));
  if (working.length > 0 && !working.every((value) => POST_DEPLOYMENT_PROOF_FILES.has(value))) {
    return working;
  }
  return [...new Set(committedFiles.map((value) => value.replaceAll("\\", "/")))];
}

export function verifyRecurrenceCoverage(stage = "complete") {
  const base = resolveAuditBase();
  const commits = readCommits(base);
  const registry = readFileSync(registryPath, "utf8");
  const uncovered = findUncoveredCommits(commits, registry);
  if (uncovered.length > 0) {
    const details = uncovered.map(({ hash, subject, incident }) =>
      `- ${hash.slice(0, 8)} ${subject}: ${incident ? `${incident} is missing or incomplete` : "missing Incident trailer"}`,
    ).join("\n");
    throw new Error(`Recurrence coverage failed for commits after ${base}:\n${details}`);
  }

  const processCommits = readCommits(DEVELOPMENT_POLICY_BASE);
  const processViolations = findProcessViolations(processCommits, registry);
  if (processViolations.length > 0) {
    const details = processViolations.map(({ hash, subject, errors }) =>
      `- ${hash.slice(0, 8)} ${subject}: ${errors.join(", ")}`,
    ).join("\n");
    throw new Error(`Development process coverage failed after ${DEVELOPMENT_POLICY_BASE}:\n${details}`);
  }

  const worktreeFiles = readWorkingTreeFiles();
  const committedFiles = processCommits.flatMap((commit) => commit.files ?? []);
  const contractFiles = selectContractFiles(worktreeFiles, committedFiles);
  if (contractFiles.length > 0) {
    if (!existsSync(changeContractPath)) {
      throw new Error("Development omission gate failed: CHANGE_CONTRACT.json is missing.");
    }
    let contract;
    try {
      contract = JSON.parse(readFileSync(changeContractPath, "utf8"));
    } catch (error) {
      throw new Error(`Development omission gate failed: invalid CHANGE_CONTRACT.json (${error.message}).`);
    }
    const contractErrors = worktreeValidationErrors(contract, contractFiles, registry, stage);
    if (contractErrors.length > 0) {
      throw new Error(`Development omission gate failed:\n- ${contractErrors.join("\n- ")}`);
    }
  }
  console.log(
    `Verified ${processCommits.length} development commit(s), ${worktreeFiles.length} worktree file(s), and recurrence coverage for ${commits.length} commit(s).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stageIndex = process.argv.indexOf("--stage");
  verifyRecurrenceCoverage(stageIndex >= 0 ? process.argv[stageIndex + 1] : "complete");
}
