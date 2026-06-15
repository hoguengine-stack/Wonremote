import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDownloadDir, resolveSafeDownloadPath, sanitizeDownloadFilename } from "./fileSafety";

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
