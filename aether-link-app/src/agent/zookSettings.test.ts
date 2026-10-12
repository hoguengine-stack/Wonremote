import { beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { applyZookNumber, readLocalZookNumber, synchronizeZookNumber } from "./zookSettings";
import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {value: (file: string, args: string[], opts: unknown) => new Promise((resolve,reject) => {
    execFile(file,args,opts,(error: Error | null,stdout: string,stderr: string) => error ? reject(error) : resolve({stdout,stderr}));
  })});
  return {execFile};
});
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("uses the latest desired number, preserves zeros and never repeats a successful native apply", async () => {
  let applied = "";
  const apply = vi.fn(async number => { applied = number; });
  const load = vi.fn(async () => "00123456");
  const report = vi.fn();
  const deps = {load, readApplied: async () => applied, apply, report};
  expect(apply).not.toHaveBeenCalled(); // No idle work or owner exists before the explicit command.
  expect(await synchronizeZookNumber(deps)).toBe(true);
  expect(apply).toHaveBeenCalledWith("00123456");
  expect(report).toHaveBeenCalledWith({appliedNumber:"00123456",error:""});
  expect(await synchronizeZookNumber(deps)).toBe(false);
  expect(apply).toHaveBeenCalledTimes(1);
  load.mockResolvedValue("87654321");
  expect(await synchronizeZookNumber(deps)).toBe(true);
  expect(applied).toBe("87654321");
});

it("rejects invalid requests, preserves the last applied value on failure and does not retry", async () => {
  const apply = vi.fn(async () => { throw new Error("cancel failed"); });
  const report = vi.fn();
  const deps = {load: async () => "00123456", readApplied: async () => "87654321", apply, report};
  expect(await synchronizeZookNumber(deps)).toBe(false);
  expect(report).toHaveBeenCalledWith({appliedNumber:"87654321",error:"cancel failed"});
  expect(apply).toHaveBeenCalledTimes(1);
  await expect(synchronizeZookNumber({...deps,load:async()=>"1234abcd"})).rejects.toThrow("8");
  expect(await synchronizeZookNumber({...deps,load:async()=>""})).toBe(false);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("keeps confirmed local state when reporting fails, without executing native setup again", async () => {
  let applied = "";
  const apply = vi.fn(async number => {applied=number;});
  const deps = {load:async()=>"00123456",readApplied:async()=>applied,apply,report:vi.fn(async(): Promise<void>=>{throw new Error("quota");})};
  await expect(synchronizeZookNumber(deps)).rejects.toThrow("quota");
  deps.report.mockResolvedValueOnce(undefined);
  expect(await synchronizeZookNumber(deps)).toBe(false);
  expect(deps.report).toHaveBeenLastCalledWith({appliedNumber:"00123456",error:""});
  expect(apply).toHaveBeenCalledTimes(1);
});

it("reads only the separate persisted number and preserves leading zeros", async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"wonremote-zook-settings-"));
  try {
    expect(await readLocalZookNumber(path.join(dir,"agent-config.json"))).toBe("");
    await writeFile(path.join(dir,"zook-number.json"),JSON.stringify("00123456"));
    expect(await readLocalZookNumber(path.join(dir,"agent-config.json"))).toBe("00123456");
    await writeFile(path.join(dir,"zook-number.json"),JSON.stringify("１２３４５６７８"));
    await expect(readLocalZookNumber(path.join(dir,"agent-config.json"))).rejects.toThrow("8");
  } finally { await rm(path.join(dir,"zook-number.json"),{force:true}); await rmdir(dir); }
});

it.skipIf(process.platform !== "win32")("executes only the installed native host with bounded fixed arguments", async () => {
  vi.stubEnv("WONREMOTE_HOST_EXE_PATH","C:\\Program Files (x86)\\WonRemote Agent\\wonremote-viewer.exe");
  vi.mocked(execFile).mockImplementation(((_file: unknown,_args: unknown,_opts: unknown,done: any) => {
    done(null, JSON.stringify({number:"014-0012-3456"}), "");
  }) as any);
  await applyZookNumber("00123456");
  expect(execFile).toHaveBeenCalledWith(expect.stringContaining("wonremote-viewer.exe"),["--agent","--configure-zook","00123456"],expect.objectContaining({windowsHide:true,timeout:260000,maxBuffer:8192}),expect.any(Function));
  await expect(applyZookNumber("1234abcd")).rejects.toThrow("8");
  expect(execFile).toHaveBeenCalledTimes(1);
});
