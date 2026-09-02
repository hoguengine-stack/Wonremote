import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");

describe("Viewer startup session policy", () => {
  it("cleans up a persisted session without restoring the remote view", () => {
    const cleanupStart = appSource.indexOf("const storedSession = consumeActiveSessionForStartupCleanup");
    const cleanupEnd = appSource.indexOf("useEffect(() =>", cleanupStart);
    const cleanupBlock = appSource.slice(cleanupStart, cleanupEnd);

    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanupBlock).toContain("closeSession(storedSession.id)");
    expect(cleanupBlock).toContain("serializeActiveSession(storedSession)");
    expect(cleanupBlock).not.toContain("setSession(");
    expect(cleanupBlock).not.toContain("fetchSessionStatus(");
  });

  it("keeps direct device connection behind the user Connect handler", () => {
    const connectStart = appSource.indexOf("async function handleConnectDevice");
    const connectEnd = appSource.indexOf("async function handleSecureConnectRequest", connectStart);
    const connectBlock = appSource.slice(connectStart, connectEnd);

    expect(connectStart).toBeGreaterThan(-1);
    expect(connectBlock).toContain("openSession(device.id)");
  });
});
