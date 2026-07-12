import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function resolveClipboardImageRoot(env: Record<string, string | undefined> = process.env): string {
  return env.WONREMOTE_AGENT_CLIPBOARD_DIR?.trim()
    || path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "WonRemote", "clipboard");
}

export async function copyPngFileToWindowsClipboard(filePath: string): Promise<void> {
  const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
  const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}'))
$source = $null
$bitmap = $null
try {
  $source = [System.Drawing.Image]::FromFile($path)
  $bitmap = New-Object System.Drawing.Bitmap($source)
  [System.Windows.Forms.Clipboard]::SetImage($bitmap)
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  if ($null -ne $source) { $source.Dispose() }
}
`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
  } as any);
}

export async function copyPngFileToWindowsClipboardAndRemove(filePath: string): Promise<void> {
  try {
    await copyPngFileToWindowsClipboard(filePath);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(filePath, { force: true });
  }
}

export async function ensureClipboardImageRoot(env: Record<string, string | undefined> = process.env): Promise<string> {
  const root = resolveClipboardImageRoot(env);
  await mkdir(root, { recursive: true });
  return root;
}
