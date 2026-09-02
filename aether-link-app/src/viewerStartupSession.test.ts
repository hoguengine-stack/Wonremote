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
    expect(cleanupBlock).toContain("closeSession(cleanupSession.id)");
    expect(cleanupBlock).toContain("enqueueSessionCleanup(window.localStorage, storedSession)");
    expect(cleanupBlock).toContain("readSessionCleanupQueue(window.localStorage)");
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

  it("deduplicates only the same device while allowing parallel connections to other devices", () => {
    const openStart = appSource.indexOf("async function runTrackedSessionOpen");
    const openEnd = appSource.indexOf("async function handleConnectDevice", openStart);
    const openBlock = appSource.slice(openStart, openEnd);

    expect(openBlock).toContain("pendingConnectDeviceIdsRef.current.has(deviceId)");
    expect(openBlock).toContain("pendingConnectDeviceIdsRef.current.add(deviceId)");
    expect(openBlock).toContain("pendingConnectDeviceIdsRef.current.delete(deviceId)");
    expect(openBlock).not.toContain("connectionEpochRef.current += 1");
  });

  it("tracks tab cleanup without cancelling unrelated connection attempts", () => {
    const closeStart = appSource.indexOf("function handleCloseSession");
    const closeEnd = appSource.indexOf("async function runTrackedSessionOpen", closeStart);
    const closeBlock = appSource.slice(closeStart, closeEnd);

    expect(closeStart).toBeGreaterThan(-1);
    expect(closeBlock).toContain("closingDeviceIdsRef.current.add(closingSession.deviceId)");
    expect(closeBlock).toContain("pendingSessionCloseTasksRef.current.add(closeTask)");
    expect(closeBlock).toContain("pendingSessionCloseTasksRef.current.delete(closeTask)");
    expect(closeBlock).not.toContain("connectionEpochRef.current += 1");
    const cleanupStart = closeBlock.indexOf("enqueueSessionCleanup(window.localStorage, closingSession)");
    const closeCall = closeBlock.indexOf("closeSession(closingSession.id)");
    expect(closeBlock.indexOf("setSessions(closedTabs.sessions)")).toBeLessThan(closeCall);
    expect(cleanupStart).toBeGreaterThan(-1);
  });

  it("waits for tab cleanup on logout and guards async clipboard input with the active tab", () => {
    const logoutStart = appSource.indexOf("async function handleLogout");
    const logoutEnd = appSource.indexOf("async function markInput", logoutStart);
    const logoutBlock = appSource.slice(logoutStart, logoutEnd);
    const panelStart = appSource.indexOf("function RemoteSessionPanel");
    const panelBlock = appSource.slice(panelStart);

    expect(logoutBlock).toContain("await Promise.all([...pendingSessionCloseTasksRef.current])");
    expect(panelBlock).toContain("React.useRef(activeSessionId)");
    expect(panelBlock).toContain("activeSessionIdRef.current = activeSessionId");
    expect(panelBlock).toContain("activeSessionIdRef.current === targetSessionId");
  });

  it("uses a fresh transfer id for retries so an old cancellation cannot overwrite them", () => {
    const retryStart = appSource.indexOf("const retryQueuedTransfer");
    const retryEnd = appSource.indexOf("const clearTerminalTransfers", retryStart);
    const retryBlock = appSource.slice(retryStart, retryEnd);

    expect(retryBlock).toContain("const retryId = `${transferId}-retry-${Date.now()}`");
    expect(retryBlock).toContain("transferSingleFile(file, retryId)");
    expect(retryBlock).not.toContain("transferSingleFile(file, transferId)");
  });
});
