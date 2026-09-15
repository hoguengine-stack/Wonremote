import { expect, it, vi } from "vitest";
import { parseAgentRollbackRequest, runPausedAgentRollback } from "./agentRollback";
import { createRemoteUpdateRequest } from "./remoteUpdateRequest";

it("rejects arbitrary paths and malformed rollback versions", () => {
  expect(parseAgentRollbackRequest("request-rollback 0.1.90 1700000000000")).toEqual({ version: "0.1.90", timestamp: "1700000000000" });
  for (const value of ["../latest", "01.1.90", "1.2", "1.2.3-beta", "1.2.3 ; calc"]) expect(parseAgentRollbackRequest(`request-rollback ${value} 1700000000000`)).toBeNull();
});
it("requires persisted pause before lookup and again at launch", async () => {
  const load = vi.fn(async () => ({ latestVersion: "0.1.90" }) as any);
  const launched = vi.fn();
  const paused = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(runPausedAgentRollback("0.1.90", { hasSession: () => false, isPaused: paused, load,
    handoff: async (_metadata, guard) => { await guard(); launched(); },
  })).rejects.toThrow("paused automatic updates");
  expect(load).toHaveBeenCalledTimes(1); expect(paused).toHaveBeenCalledTimes(2); expect(launched).not.toHaveBeenCalled();
  paused.mockResolvedValue(false); load.mockClear();
  await expect(runPausedAgentRollback("0.1.90", { hasSession: () => false, isPaused: paused, load, handoff: vi.fn() })).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
});
it("preserves explicit rollback version through the existing session/dedup gate", async () => {
  let session = true;
  const gate = createRemoteUpdateRequest(() => session);
  const load = vi.fn(async () => ({ latestVersion: "0.1.90" }) as any);
  const handoff = vi.fn(async (_metadata, guard) => { await guard(); });
  const deps = { hasSession: () => session, isPaused: vi.fn(async () => true), load, handoff };
  const request = parseAgentRollbackRequest("request-rollback 0.1.90 1700000000000")!;
  const action = `request-update ${request.timestamp}`;
  const run = () => runPausedAgentRollback(request.version, deps).then(() => undefined);
  await gate.receive(action, run, 1700000000000);
  await gate.receive(action, run, 1700000000000);
  expect(load).not.toHaveBeenCalled();
  session = false; await gate.drain(); await gate.drain();
  expect(load).toHaveBeenCalledExactlyOnceWith("0.1.90"); expect(handoff).toHaveBeenCalledTimes(1);
});
it("defers if a session starts while signed metadata is loading", async () => {
  let active = false;
  const handoff = vi.fn();
  expect(await runPausedAgentRollback("0.1.90", { hasSession: () => active, isPaused: async () => true,
    load: async () => { active = true; return {} as any; }, handoff,
  })).toBe("deferred");
  expect(handoff).not.toHaveBeenCalled();
});
