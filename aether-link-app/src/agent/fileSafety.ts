import path from "node:path";

const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
const WINDOWS_INVALID_PATH_SEGMENT = /[<>:"|?*\x00-\x1F]/;

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

export function resolveSafeDownloadPath(
  downloadsDir: string,
  filename: string,
  webkitRelativePath?: string,
): string {
  const root = path.resolve(downloadsDir);
  const explicitRelativePath = webkitRelativePath?.trim() ? webkitRelativePath : undefined;
  const filenameCarriesRelativePath = /[\\/]/.test(filename);
  const relativeSegments = explicitRelativePath || filenameCarriesRelativePath
    ? parseSafeRelativePath(explicitRelativePath || filename)
    : [sanitizeDownloadFilename(filename)];
  const target = path.resolve(root, ...relativeSegments);
  const relative = path.relative(root, target);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Unsafe download relative path");
  }

  return target;
}

function parseSafeRelativePath(relativePath: string): string[] {
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new Error("Unsafe download relative path");
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      WINDOWS_INVALID_PATH_SEGMENT.test(segment) ||
      /[. ]$/.test(segment) ||
      WINDOWS_RESERVED_FILENAME.test(segment)
    ) {
      throw new Error("Unsafe download relative path");
    }
  }
  return segments;
}
