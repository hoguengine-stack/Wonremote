import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { selectFileToSend } from "./selectFileToSend";

let child: EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); mocks.spawn.mockReset();
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(() => true) });
  mocks.spawn.mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); child.stdout.destroy(); });
const select = (signal?: AbortSignal) => selectFileToSend(signal, { SystemRoot: "C:\\Windows" }, "win32");

describe("trusted reverse file selection", () => {
  it("uses a fixed local dialog script without interpolating file paths", async () => {
    const pending = select();
    const [executable, args, options] = mocks.spawn.mock.calls[0];
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(options).toMatchObject({ shell: false, windowsHide: true });
    const script = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
    expect(script).toContain("UserInteractive"); expect(script).toContain("IsSystem");
    child.stdout.write(JSON.stringify("C:\\Reports\\report.txt")); child.emit("close", 0);
    await expect(pending).resolves.toBe("C:\\Reports\\report.txt");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns user cancellation without starting a transfer", async () => {
    const pending = select(); child.stdout.write("null"); child.emit("close", 0);
    await expect(pending).resolves.toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["invalid-json", JSON.stringify("relative.txt"), JSON.stringify("\\\\server\\share\\file"), JSON.stringify(42)])("rejects invalid picker output %s", async output => {
    const pending = select(); const assertion = expect(pending).rejects.toThrow("Invalid file selection");
    child.stdout.write(output); child.emit("close", 0); await assertion;
  });
  it("kills helper and removes cancellation listener on disconnect", async () => {
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = select(controller.signal); const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion;
    expect(child.kill).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds an unattended picker lifetime", async () => {
    const pending = select(); const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_000); await assertion;
    expect(child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains cancellation even when process termination throws", async () => {
    child.kill.mockImplementation(() => { throw new Error("already stopped"); });
    const controller = new AbortController();
    const pending = select(controller.signal); const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("terminates oversized responses", async () => {
    const pending = select(); const assertion = expect(pending).rejects.toThrow("Invalid file selection");
    child.stdout.write("x".repeat(65_537)); await assertion;
    expect(child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not spawn for a cancelled or unsupported selection", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(select(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(selectFileToSend(undefined, {}, "linux")).rejects.toThrow("requires Windows");
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects noninteractive and failed process execution", async () => {
    const pending = select(); const assertion = expect(pending).rejects.toThrow("interactive Windows");
    child.emit("close", 2); await assertion;
    const next = select(); const nextAssertion = expect(next).rejects.toThrow("Could not open");
    child.emit("error", new Error("spawn failed")); await nextAssertion;
  });
});
