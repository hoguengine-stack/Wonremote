import { describe, expect, it, vi } from "vitest";
import { saveDesktopFile, type DownloadInvoke } from "./desktopFileSave";

describe("desktop file destination", () => {
  it("writes exact ordered bytes and reports success only after native commit", async () => {
    const bytes = Uint8Array.from({length: 150003}, (_, i) => i % 251);
    const chunks: Buffer[] = [];
    const calls: string[] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === "begin_viewer_download") return "local-1";
      if (command === "write_viewer_download") {
        expect(args?.offset).toBe(chunks.reduce((n, b) => n + b.length, 0));
        chunks.push(Buffer.from(args!.data as string, "base64"));
      }
      if (command === "finish_viewer_download") return "C:/Downloads/remote.txt";
    }) as DownloadInvoke;
    expect(await saveDesktopFile({filename:"remote.txt",blob:new Blob([bytes])},invoke)).toBe("C:/Downloads/remote.txt");
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    expect(calls).toEqual(["begin_viewer_download",...Array(3).fill("write_viewer_download"),"finish_viewer_download"]);
  });
  it("aborts failed local writes without reporting success or opening a remote folder", async () => {
    const calls: string[] = [];
    const invoke = (async (command: string) => {
      calls.push(command);
      if (command === "begin_viewer_download") return "local-1";
      if (command === "write_viewer_download") throw Error("Disk full");
    }) as DownloadInvoke;
    await expect(saveDesktopFile({filename:"a.txt",blob:new Blob(["a"])},invoke)).rejects.toThrow("Disk full");
    expect(calls).toEqual(["begin_viewer_download","write_viewer_download","abort_viewer_download"]);
  });
});
