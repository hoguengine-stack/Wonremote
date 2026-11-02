import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => mocks.execute }));
import { publishFileWithoutOverwrite } from "./filePublication";
afterEach(() => { mocks.execute.mockReset(); vi.unstubAllEnvs(); });

describe("native no-replace publication boundary", () => {
  it("uses only the bundled executable and fixed bounded non-shell arguments", async () => {
    const executable = path.resolve("bin/wonremote-poc.exe");
    vi.stubEnv("WONREMOTE_POC_PATH", executable);
    mocks.execute.mockResolvedValue({ stdout: '{"ok":true}' });
    await publishFileWithoutOverwrite("C:\\Downloads\\received.part", "C:\\Downloads\\new.txt");
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(executable,
      ["--publish-received-file", "C:\\Downloads\\received.part", "C:\\Downloads\\new.txt"],
      { windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096, encoding: "utf8" });
  });
  it.each([80, 183])("preserves native filename collision %s without reporting success", async win32Error => {
    mocks.execute.mockResolvedValue({ stdout: JSON.stringify({ ok: false, win32Error }) });
    await expect(publishFileWithoutOverwrite("a", "b")).rejects.toMatchObject({ code: "EEXIST" });
  });
  it("does not retry native permission, malformed output or timeout failures", async () => {
    mocks.execute.mockResolvedValueOnce({ stdout: '{"ok":false,"win32Error":5}' });
    await expect(publishFileWithoutOverwrite("a", "b")).rejects.toMatchObject({ code: "EIO" });
    mocks.execute.mockResolvedValueOnce({ stdout: 'invalid' });
    await expect(publishFileWithoutOverwrite("a", "b")).rejects.toThrow();
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    mocks.execute.mockRejectedValueOnce(timeout);
    await expect(publishFileWithoutOverwrite("a", "b")).rejects.toBe(timeout);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });
});
