import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const firebaseSourceFiles = ["agentFirebase.ts", "viewerFirebase.ts"];

describe("Firebase write architecture", () => {
  it("routes Firestore writes through safe wrappers instead of direct SDK calls", () => {
    for (const fileName of firebaseSourceFiles) {
      const source = readFileSync(join(process.cwd(), "src", "firebase", fileName), "utf8");

      const firestoreImport = source.match(/from "firebase\/firestore";\n/s)?.[0] ?? "";
      expect(firestoreImport).not.toMatch(/\baddDoc\b/);
      expect(firestoreImport).not.toMatch(/\bsetDoc\b/);
      expect(firestoreImport).not.toMatch(/\bupdateDoc\b/);

      expect(source).not.toMatch(/\baddDoc\s*\(/);
      expect(source).not.toMatch(/\bsetDoc\s*\(/);
      expect(source).not.toMatch(/\bupdateDoc\s*\(/);
      expect(source).not.toMatch(/\bbatch\.update\s*\(/);
    }
  });
});
