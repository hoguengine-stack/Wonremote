import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDownloadDir, resolveSafeDownloadPath, sanitizeDownloadFilename } from "./fileSafety";

describe("agent file safety", () => {
  it("keeps single files inside the configured downloads directory", () => {
    const downloadsDir = path.join("C:", "Users", "tester", "AppData", "Roaming", "WonRemote", "Downloads");

    expect(resolveSafeDownloadPath(downloadsDir, "report.txt")).toBe(path.resolve(downloadsDir, "report.txt"));
  });

  it("preserves safe webkitRelativePath subfolders", () => {
    const downloadsDir = path.join("C:", "Users", "tester", "Desktop");

    expect(resolveSafeDownloadPath(downloadsDir, "report.txt", "Store/reports/2026/report.txt")).toBe(
      path.resolve(downloadsDir, "Store", "reports", "2026", "report.txt"),
    );
    expect(resolveSafeDownloadPath(downloadsDir, "Store\\reports\\report.txt")).toBe(
      path.resolve(downloadsDir, "Store", "reports", "report.txt"),
    );
  });

  it.each([
    "../secret.txt",
    "Store/../../secret.txt",
    "/Windows/System32/file.txt",
    "C:\\Windows\\file.txt",
    "\\\\server\\share\\file.txt",
    "Store/CON/report.txt",
    "Store/COM¹.txt",
    "Store/CONOUT$/report.txt",
    "Store/report.txt:Zone.Identifier",
    "Store/trailing./report.txt",
    "Store/report.txt ",
  ])("rejects unsafe relative download path %s", (unsafePath) => {
    expect(() => resolveSafeDownloadPath("C:\\Downloads", "report.txt", unsafePath)).toThrow(
      "Unsafe download relative path",
    );
  });

  it("normalizes empty, invalid, and reserved Windows filenames", () => {
    expect(sanitizeDownloadFilename("")).toBe("download.bin");
    expect(sanitizeDownloadFilename("bad:name?.txt")).toBe("bad_name_.txt");
    expect(sanitizeDownloadFilename("CON")).toBe("_CON");
    expect(sanitizeDownloadFilename("payload. ")).toBe("payload");
  });

  it("uses the user's Desktop as the default received-file directory", () => {
    const userProfile = path.join("C:", "Users", "tester");

    expect(resolveAgentDownloadDir({ USERPROFILE: userProfile })).toBe(path.resolve(userProfile, "Desktop"));
  });

  it("allows tests and local harnesses to override the received-file directory", () => {
    const overrideDir = path.join("D:", "WonRemote", "incoming");

    expect(
      resolveAgentDownloadDir({
        USERPROFILE: path.join("C:", "Users", "tester"),
        WONREMOTE_AGENT_DOWNLOADS_DIR: overrideDir,
      }),
    ).toBe(path.resolve(overrideDir));
    expect(
      resolveAgentDownloadDir({
        USERPROFILE: path.join("C:", "Users", "tester"),
        WONREMOTE_DOWNLOAD_DIR: overrideDir,
      }),
    ).toBe(path.resolve(overrideDir));
  });
});
