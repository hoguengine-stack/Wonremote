import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const repoRoot = path.resolve(projectRoot, "..");

describe("Firebase deploy readiness", () => {
  it("passes the offline readiness checker before any Firebase deploy", () => {
    const output = execFileSync(process.execPath, [path.join(projectRoot, "scripts", "verify-firebase-deploy-readiness.js")], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    expect(output).toContain("Firebase deploy readiness OK.");
  });

  it("exposes an npm script so deploy verification is not a manual checklist", () => {
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const deployScript = readFileSync(path.join(projectRoot, "scripts", "deploy-firebase.ps1"), "utf8");
    const readinessScript = readFileSync(path.join(projectRoot, "scripts", "verify-firebase-deploy-readiness.js"), "utf8");
    const firebaseJson = JSON.parse(readFileSync(path.join(repoRoot, "firebase.json"), "utf8")) as {
      firestore?: { rules?: string };
      storage?: { rules?: string };
    };

    expect(packageJson.scripts?.["firebase:verify"]).toBe("node scripts/verify-firebase-deploy-readiness.js");
    expect(deployScript).toContain("WONREMOTE_FIREBASE_DEPLOY_APPROVED");
    expect(readinessScript).toContain("realtimeTransportPolicy.ts");
    expect(readinessScript).toContain("shouldPollViewerTileFallback");
    expect(readinessScript).toContain("webrtc-unavailable");
    expect(firebaseJson.firestore?.rules).toBe("firestore.rules");
    expect(firebaseJson.storage?.rules).toBe("storage.rules");
  });
});
