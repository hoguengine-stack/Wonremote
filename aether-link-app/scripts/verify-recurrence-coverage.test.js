import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeValidationErrors,
  findIncidentByFixCommit,
  findProcessViolations,
  findUncoveredCommits,
  incidentValidationErrors,
  parseIncidentTrailer,
  requestReviewErrors,
  selectContractFiles,
  worktreeValidationErrors,
} from "./verify-recurrence-coverage.js";

describe("recurrence coverage gate", () => {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = path.resolve(appRoot, "..");
  const fields = [
    "Detected", "Severity", "Affected", "Status", "User-visible symptom", "Minimal trigger",
    "Root cause and contributors", "Fix commit(s)", "Permanent guard", "Regression proof",
    "Release proof", "Remaining blocker",
  ];
  const registry = `## INC-20260817-001: Example\n${fields.map((field) => `- ${field}: value`).join("\n")}\n`;

  it("accepts a defect fix only when its Incident trailer resolves to the registry", () => {
    expect(parseIncidentTrailer("Details\n\nIncident: INC-20260817-001")).toBe("INC-20260817-001");
    expect(findUncoveredCommits([
      { hash: "a".repeat(40), subject: "Fix installed updater", body: "Incident: INC-20260817-001" },
    ], registry)).toEqual([]);
  });

  it("rejects missing trailers and unknown incident ids", () => {
    const uncovered = findUncoveredCommits([
      { hash: "a".repeat(40), subject: "Fix installed updater", body: "" },
      { hash: "b".repeat(40), subject: "Retry release publication", body: "Incident: INC-20260817-999" },
      { hash: "c".repeat(40), subject: "Add Viewer label", body: "" },
    ], registry);
    expect(uncovered.map(({ hash }) => hash[0])).toEqual(["a", "b"]);
  });

  it("accepts a historical fix when its registry entry names the commit", () => {
    const historicalRegistry = registry.replace("- Fix commit(s): value", `- Fix commit(s): ${"a".repeat(8)}`);
    expect(findIncidentByFixCommit("a".repeat(40), historicalRegistry)).toBe("INC-20260817-001");
    expect(findUncoveredCommits([
      { hash: "a".repeat(40), subject: "Fix historical defect", body: "" },
    ], historicalRegistry)).toEqual([]);
  });

  it("covers non-Fix defect subjects and rejects incomplete incident entries", () => {
    expect(findUncoveredCommits([
      { hash: "a".repeat(40), subject: "Speed up release packaging", body: "" },
      { hash: "b".repeat(40), subject: "Align release contract tests", body: "" },
    ], registry)).toHaveLength(2);
    expect(incidentValidationErrors("INC-20260817-001", "## INC-20260817-001: Incomplete\n- Detected: now\n"))
      .toContain("Regression proof");
  });

  it("requires lifecycle evidence for every development commit", () => {
    const body = [
      "Intent: Deliver the requested behavior",
      "Change-Type: feature",
      "Risk: medium",
      "Acceptance: The user sees the requested behavior",
      "Contract: src/example.test.ts",
      "Proof-Level: automated-runtime",
      "Verification: npx vitest run src/example.test.ts -> passed",
      "Release-Impact: build",
      "Rollback: revert this commit",
      "Request-Review: none - test-only fixture; no network behavior changed",
    ].join("\n");
    expect(changeValidationErrors({ subject: "Add behavior", body, files: ["src/example.test.ts"] }, registry)).toEqual([]);
    expect(findProcessViolations([{ hash: "a".repeat(40), subject: "Add behavior", body: "" }], registry)[0].errors)
      .toContain("missing Intent trailer");
  });

  it("requires every fix to resolve to a complete incident", () => {
    const body = [
      "Intent: Restore the broken behavior",
      "Change-Type: fix",
      "Risk: high",
      "Acceptance: The broken user path works again",
      "Contract: src/example.test.ts",
      "Proof-Level: automated-runtime",
      "Verification: npx vitest run src/example.test.ts -> passed",
      "Release-Impact: build-and-deploy",
      "Rollback: revert this commit",
      "Request-Review: none - test-only fixture; no network behavior changed",
    ].join("\n");
    expect(changeValidationErrors({ subject: "Correct behavior", body, files: ["src/example.test.ts"] }, registry))
      .toContain("fix requires Incident trailer");
    expect(changeValidationErrors({
      subject: "Correct behavior",
      body: `${body}\nIncident: INC-20260817-001`,
      files: ["src/example.test.ts"],
    }, registry))
      .toEqual([]);
  });

  it("rejects a functional change when its contract test was not changed", () => {
    const body = [
      "Intent: Add behavior",
      "Change-Type: feature",
      "Risk: medium",
      "Acceptance: The user sees the behavior",
      "Contract: src/example.test.ts",
      "Proof-Level: automated-runtime",
      "Verification: npx vitest run src/example.test.ts -> passed",
      "Release-Impact: build",
      "Rollback: revert this commit",
      "Request-Review: none - test-only fixture; no network behavior changed",
    ].join("\n");
    expect(changeValidationErrors({ subject: "Add behavior", body, files: ["src/example.ts"] }, registry))
      .toContain("functional change Contract must name a test changed with the implementation");
  });

  it("blocks completion while the active acceptance contract is pending", () => {
    const contract = {
      status: "active",
      requestReview: { impact: "none", reason: "Test-only fixture" },
      intent: "Prove the visible outcome",
      changeType: "feature",
      risk: "high",
      releaseImpact: "build",
      rollback: "revert this change",
      outcomes: [{
        id: "first-frame",
        acceptance: "A visible frame reaches the Viewer",
        boundaries: ["Viewer", "signaling", "Agent", "capture", "first frame"],
        contractTests: ["src/example.test.ts"],
        proofLevel: "physical-required",
        verification: "pending",
        physicalGap: "Verify first frame on a physical device",
      }],
    };
    const errors = worktreeValidationErrors(contract, ["src/example.test.ts"], registry);
    expect(errors).toContain("outcomes[0].verification must contain fresh evidence");
    expect(errors).toContain("CHANGE_CONTRACT.json status must be verified for complete");
  });

  it("requires separate proof for every declared user-visible outcome", () => {
    const contract = {
      status: "verified",
      requestReview: { impact: "none", reason: "Test-only fixture" },
      intent: "Prove two visible outcomes",
      changeType: "feature",
      risk: "high",
      releaseImpact: "build",
      rollback: "revert this change",
      outcomes: [
        {
          id: "screen",
          acceptance: "The screen is visible",
          boundaries: ["Viewer", "Agent"],
          contractTests: ["src/screen.test.ts"],
          proofLevel: "automated-runtime",
          verification: "screen test passed",
          physicalGap: "none",
        },
        {
          id: "input",
          acceptance: "Input reaches the Agent",
          boundaries: ["Viewer", "Agent"],
          contractTests: ["src/input.test.ts"],
          proofLevel: "automated-runtime",
          verification: "input test passed",
          physicalGap: "none",
        },
      ],
    };
    expect(worktreeValidationErrors(contract, ["src/screen.test.ts"], registry))
      .toContain("outcomes[1].contractTests must include a test changed with the implementation");
  });

  it("allows only deployment outcomes to remain pending at the predeploy gate", () => {
    const contract = {
      status: "ready-to-deploy",
      requestReview: { impact: "none", reason: "Test-only fixture" },
      intent: "Deploy a verified build",
      changeType: "feature",
      risk: "medium",
      releaseImpact: "deploy",
      rollback: "redeploy the previous release",
      outcomes: [{
        id: "live-route",
        acceptance: "The live route serves the new artifact",
        boundaries: ["build", "hosting", "live URL"],
        contractTests: ["src/deploy.test.ts"],
        proofLevel: "deployment-required",
        verification: "pending",
        physicalGap: "none",
      }],
    };
    expect(worktreeValidationErrors(contract, ["src/deploy.test.ts"], registry, "predeploy")).toEqual([]);
    expect(worktreeValidationErrors(contract, ["src/deploy.test.ts"], registry))
      .toContain("outcomes[0].verification must contain fresh evidence");
  });

  it("keeps the development-wide policy wired into local and CI gates", () => {
    const rules = readFileSync(path.join(repositoryRoot, "AGENTS.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
    const workflow = readFileSync(path.join(repositoryRoot, ".github", "workflows", "publish-release.yml"), "utf8");

    expect(rules).toContain("requirement analysis, design, implementation, testing, build, deployment");
    expect(rules).toContain("npm run change:verify");
    expect(rules).toContain("Could this proof pass while the user-visible feature is still broken?");
    expect(rules).toContain("one `outcomes` entry for every user-requested result");
    expect(rules).toContain("Request-Review:");
    expect(rules).toContain("Request Waste Prevention");
    expect(packageJson.scripts["change:verify"]).toBe("node scripts/verify-recurrence-coverage.js");
    expect(packageJson.scripts["change:verify:predeploy"]).toContain("--stage predeploy");
    expect(workflow).toContain("change-guard:");
    expect(workflow).toContain("needs: change-guard");
    expect(workflow).toContain("Verify development and recurrence coverage");
    expect(workflow).toContain("node aether-link-app/scripts/verify-recurrence-coverage.js");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    const gate = readFileSync(path.join(appRoot, "scripts", "verify-recurrence-coverage.js"), "utf8");
    expect(gate).not.toContain('git(["ls-files", "--others", "--exclude-standard"])');
    expect(gate).toContain("selectContractFiles(worktreeFiles, committedFiles)");
    expect(gate).toContain("worktreeValidationErrors(contract, contractFiles, registry, stage)");
  });

  it("uses committed boundaries for clean or post-deployment proof-only changes", () => {
    const committed = ["src/release.test.ts", "src/release.ts"];
    expect(selectContractFiles([], committed)).toEqual(committed);
    expect(selectContractFiles(["CHANGE_CONTRACT.json", "INCIDENT_REGISTRY.md"], committed)).toEqual(committed);
    expect(selectContractFiles(["src/current.ts", "CHANGE_CONTRACT.json"], committed))
      .toEqual(["src/current.ts", "CHANGE_CONTRACT.json"]);
  });

  it("rejects missing request review rather than silently treating it as no impact", () => {
    expect(requestReviewErrors(undefined, [])).toContain("requestReview.impact must be none or changed");
    expect(requestReviewErrors({ impact: "none", reason: "pending" }, [])).toContain("requestReview.reason is required");
    expect(requestReviewErrors({ impact: "none", reason: "Only label text changes" }, [])).toEqual([]);
    expect(changeValidationErrors({ body: "", files: [] }, registry)).toContain("missing Request-Review trailer");
    expect(worktreeValidationErrors({ outcomes: [] }, [], registry)).toContain("requestReview.impact must be none or changed");
  });

  it("requires measured lifecycle evidence and a changed boundary test for request changes", () => {
    const review = {
      impact: "changed", reason: "Replace history polling with a subscription",
      assumptions: "One Viewer, startup included, no changed documents or reconnects during the idle day",
      dailyBudget: { clients: 1, readsPerClient: 200, writesPerClient: 0, maxReads: 200, maxWrites: 0 },
      checks: { idle: "24h fake timer passed", rerender: "no new listener", concurrency: "one in-flight request", failure: "quota pauses retries", cleanup: "unsubscribe stops requests" },
      contractTests: ["src/requests.test.ts"],
    };
    expect(requestReviewErrors(review, ["src/requests.test.ts"])).toEqual([]);
    expect(requestReviewErrors(review, [])).toContain("requestReview.contractTests must name a changed request-boundary test");
    expect(requestReviewErrors({ ...review, checks: { idle: "passed" } }, ["src/requests.test.ts"]))
      .toContain("requestReview.checks.cleanup requires evidence");
    expect(requestReviewErrors({ ...review, dailyBudget: { ...review.dailyBudget, clients: 2 } }, ["src/requests.test.ts"]))
      .toContain("requestReview.dailyBudget exceeds its declared read/write limits");
    expect(requestReviewErrors({ ...review, dailyBudget: { ...review.dailyBudget, readsPerClient: "200" } }, ["src/requests.test.ts"]))
      .toContain("requestReview.dailyBudget requires finite nonnegative counts and positive integer clients");
  });
});
