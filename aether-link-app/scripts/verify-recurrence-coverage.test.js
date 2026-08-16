import { describe, expect, it } from "vitest";
import { findUncoveredCommits, incidentValidationErrors, parseIncidentTrailer } from "./verify-recurrence-coverage.js";

describe("recurrence coverage gate", () => {
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

  it("covers non-Fix defect subjects and rejects incomplete incident entries", () => {
    expect(findUncoveredCommits([
      { hash: "a".repeat(40), subject: "Speed up release packaging", body: "" },
      { hash: "b".repeat(40), subject: "Align release contract tests", body: "" },
    ], registry)).toHaveLength(2);
    expect(incidentValidationErrors("INC-20260817-001", "## INC-20260817-001: Incomplete\n- Detected: now\n"))
      .toContain("Regression proof");
  });
});
