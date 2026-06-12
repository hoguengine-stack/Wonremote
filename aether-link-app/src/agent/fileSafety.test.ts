import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSafeDownloadPath, sanitizeDownloadFilename } from "./fileSafety";

describe("agent file safety", () => {
  it("keeps transferred files inside the configured downloads directory", () => {
    const downloadsDir = path.join("C:", "Users", "tester", "AppData", "Roaming", "WonRemote", "Downloads");

    expect(resolveSafeDownloadPath(downloadsDir, "report.txt")).toBe(path.resolve(downloadsDir, "report.txt"));
    expect(resolveSafeDownloadPath(downloadsDir, "..\\..\\Windows\\win.ini")).toBe(
      path.resolve(downloadsDir, "win.ini"),
    );
    expect(resolveSafeDownloadPath(downloadsDir, "../secret.txt")).toBe(path.resolve(downloadsDir, "secret.txt"));
  });

  it("normalizes empty, invalid, and reserved Windows filenames", () => {
    expect(sanitizeDownloadFilename("")).toBe("download.bin");
    expect(sanitizeDownloadFilename("bad:name?.txt")).toBe("bad_name_.txt");
    expect(sanitizeDownloadFilename("CON")).toBe("_CON");
    expect(sanitizeDownloadFilename("payload. ")).toBe("payload");
  });
});
