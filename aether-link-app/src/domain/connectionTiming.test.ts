import { describe, expect, it, vi } from "vitest";
import { beginConnectionTiming, bindConnectionTiming, markConnectionTiming } from "./connectionTiming";
describe("local connection timing", () => {
 it("uses monotonic time and excludes identifiers, deduplicates and terminates", () => {
   const now = vi.spyOn(performance, "now"); const log = vi.spyOn(console, "info").mockImplementation(() => {});
   now.mockReturnValue(10); beginConnectionTiming("private-device", "viewer");
   now.mockReturnValue(40); bindConnectionTiming("private-device", "private-session");
   markConnectionTiming("private-session", "session-ready"); markConnectionTiming("private-session", "session-ready");
   now.mockReturnValue(110); markConnectionTiming("private-session", "first-picture");
   markConnectionTiming("private-session", "frame-received");
   expect(log).toHaveBeenCalledTimes(3);
   const lines = log.mock.calls.flat().join(" "); expect(lines).not.toContain("private");
   expect(lines).toContain('"elapsedMs":100'); log.mockRestore(); now.mockRestore();
 });
 it("bounds abandoned attempts and produces no idle timer activity", () => {
   vi.useFakeTimers(); const log=vi.spyOn(console,"info").mockImplementation(()=>{});
   for(let i=0;i<40;i++) beginConnectionTiming(`abandoned-${i}`, "agent");
   log.mockClear(); markConnectionTiming("abandoned-0", "capture-start");
   vi.advanceTimersByTime(86400000); expect(log).not.toHaveBeenCalled();
   log.mockRestore(); vi.useRealTimers();
 });
});
