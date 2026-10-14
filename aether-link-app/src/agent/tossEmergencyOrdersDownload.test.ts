import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTossEmergencyOrders } from "./tossEmergencyOrdersDownload";

vi.mock("./tossEmergencyOrdersAsset.json", () => ({ default: {
  url: "https://github.com/fixture/releases/download/fixed/TossEmergencyOrders-Setup-x86.exe",
  filename: "TossEmergencyOrders-Setup-x86.exe", size: 7,
  sha256: createHash("sha256").update("fixture").digest("hex"),
} }));

describe("remote TossEmergencyOrders download", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("saves verified bytes only once in remote Downloads and reuses the identical file without fetching", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wonremote-toss-"));
    let finish!: () => void;
    const fetcher = vi.fn(async () => { await new Promise<void>(resolve => {finish=resolve;}); return new Response("fixture"); });
    vi.stubGlobal("fetch", fetcher);
    try {
      const first = downloadTossEmergencyOrders({USERPROFILE:root});
      const second = downloadTossEmergencyOrders({USERPROFILE:root});
      expect(second).toBe(first);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      finish();
      const file = await first;
      expect(file).toBe(path.join(root,"Downloads","TossEmergencyOrders-Setup-x86.exe"));
      expect(await readFile(file,"utf8")).toBe("fixture");
      expect(fetcher.mock.calls[0]).toEqual(["https://github.com/fixture/releases/download/fixed/TossEmergencyOrders-Setup-x86.exe",{signal:expect.any(AbortSignal)}]);
      expect(await downloadTossEmergencyOrders({USERPROFILE:root})).toBe(file);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it.each(["hash", "oversize", "http", "timeout", "existing"])("preserves files and clears in-flight failure: %s", async failure => {
    const root = await mkdtemp(path.join(tmpdir(),"wonremote-toss-"));
    await mkdir(path.join(root,"Downloads"));
    const target = path.join(root,"Downloads","TossEmergencyOrders-Setup-x86.exe");
    if(failure==='existing') await writeFile(target,"user file");
    const fetcher=vi.fn(async()=>{
      if(failure==='timeout') throw new DOMException('Timeout','TimeoutError');
      return new Response(failure==='hash'?'changed':failure==='oversize'?'too-large':'fixture',{status:failure==='http'?404:200});
    });
    vi.stubGlobal('fetch',fetcher);
    try {
      await expect(downloadTossEmergencyOrders({USERPROFILE:root})).rejects.toThrow();
      expect(await readdir(path.join(root,"Downloads"))).toEqual(failure==='existing'?['TossEmergencyOrders-Setup-x86.exe']:[]);
      if(failure==='existing') {
        expect(await readFile(target,"utf8")).toBe('user file'); expect(fetcher).not.toHaveBeenCalled();
      } else {
        fetcher.mockImplementation(async()=>new Response('fixture'));
        expect(await downloadTossEmergencyOrders({USERPROFILE:root})).toBe(target);
      }
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("rejects unavailable or relative remote profile before fetching", async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(downloadTossEmergencyOrders({})).rejects.toThrow('profile');
    await expect(downloadTossEmergencyOrders({USERPROFILE:'../other'})).rejects.toThrow('profile');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
