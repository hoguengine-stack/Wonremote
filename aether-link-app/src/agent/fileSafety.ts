import path from "node:path";

const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function resolveAgentDownloadDir(env: Record<string, string | undefined> = process.env): string {
  const overrideDir = env.WONREMOTE_AGENT_DOWNLOADS_DIR?.trim() || env.WONREMOTE_DOWNLOAD_DIR?.trim();
  if (overrideDir) {
    return path.resolve(overrideDir);
  }

  const userProfile = env.USERPROFILE?.trim();
  if (userProfile) {
    return path.resolve(userProfile, "Desktop");
  }

  return path.resolve(env.APPDATA ?? process.cwd(), "WonRemote", "Downloads");
}

export function sanitizeDownloadFilename(filename: string): string {
  const basename = path.basename(filename.trim() || "download.bin");
  const sanitized = basename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "");

  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "download.bin";
  }

  if (WINDOWS_RESERVED_FILENAME.test(sanitized)) {
    return `_${sanitized}`;
  }

  return sanitized;
}

export function resolveSafeDownloadPath(downloadsDir: string, filename: string): string {
  const root = path.resolve(downloadsDir);
  const target = path.resolve(root, sanitizeDownloadFilename(filename));
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe download filename");
  }

  return target;
}
