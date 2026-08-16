import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appRoot, "..");
const registryPath = path.join(repositoryRoot, "INCIDENT_REGISTRY.md");

export const INCIDENT_COMMIT_PATTERN = /^(?:Fix|Retry|Repair|Prevent|Recover)\b|^(?:Harden|Align|Prepare|Split|Limit|Reduce|Speed up|Keep)\b.*\b(?:failure|update|release|installer|runtime|WebRTC|Agent|regression|resource|build|publication|cache)\b/i;
const REQUIRED_INCIDENT_FIELDS = [
  "Detected", "Severity", "Affected", "Status", "User-visible symptom", "Minimal trigger",
  "Root cause and contributors", "Fix commit(s)", "Permanent guard", "Regression proof",
  "Release proof", "Remaining blocker",
];

export function parseIncidentTrailer(body) {
  return body.match(/^Incident:\s*(INC-\d{8}-\d{3})\s*$/im)?.[1] ?? null;
}

export function findUncoveredCommits(commits, registry) {
  return commits
    .filter(({ subject }) => INCIDENT_COMMIT_PATTERN.test(subject))
    .map((commit) => ({ ...commit, incident: parseIncidentTrailer(commit.body) }))
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
    return { hash, subject, body: bodyParts.join("\x1f") };
  });
}

export function verifyRecurrenceCoverage() {
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
  console.log(`Verified recurrence coverage for ${commits.length} commit(s) after ${base}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyRecurrenceCoverage();
}
