import { hostname as readSystemHostname } from "node:os";
import process from "node:process";
import { buildDesktopName } from "../firebase/firebaseIdentity";

interface ResolveAgentComputerNameOptions {
  businessNumber: string;
  env?: Record<string, string | undefined>;
  installId: string;
  platform?: string;
  readHostname?: () => string;
  storedDesktopName?: string;
}

export function resolveAgentComputerName({
  businessNumber,
  env = process.env,
  installId,
  platform = process.platform,
  readHostname = readSystemHostname,
  storedDesktopName,
}: ResolveAgentComputerNameOptions): string {
  const fallback = buildDesktopName(businessNumber, installId);
  if (platform !== "win32") {
    return fallback;
  }

  const currentName = normalizeWindowsComputerName(env.COMPUTERNAME)
    ?? normalizeWindowsComputerName(safeReadHostname(readHostname));
  if (currentName) {
    return currentName;
  }

  return normalizeWindowsComputerName(storedDesktopName) ?? fallback;
}

function safeReadHostname(readHostname: () => string): string {
  try {
    return readHostname();
  } catch {
    return "";
  }
}

function normalizeWindowsComputerName(value: string | undefined): string | null {
  const name = value?.trim();
  if (
    !name
    || name.length > 255
    || /[\\/:*?"<>|\s\u0000-\u001f]/u.test(name)
    || /^(?:localhost|localhost\.localdomain|%computername%)$/i.test(name)
  ) {
    return null;
  }
  return name;
}
