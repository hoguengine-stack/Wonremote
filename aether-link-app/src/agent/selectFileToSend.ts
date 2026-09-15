import { spawn } from "node:child_process";
import path from "node:path";

const PICK_FILE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if (-not [Environment]::UserInteractive -or [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'WonRemote - Select a file to send'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -InputObject $dialog.FileName -Compress
  } else { 'null' }
} finally { $dialog.Dispose() }
`;

export async function selectFileToSend(
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (signal?.aborted) throw new DOMException("File selection cancelled.", "AbortError");
  if (platform !== "win32") throw new Error("File selection requires Windows.");
  if (!env.SystemRoot || !path.win32.isAbsolute(env.SystemRoot)) throw new Error("Windows directory is unavailable.");
  return new Promise((resolve, reject) => {
    const child = spawn(path.win32.join(env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(PICK_FILE_SCRIPT, "utf16le").toString("base64")],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let settled = false;
    let output = "";
    const finish = (error?: Error, selected: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(selected);
    };
    const stop = (error: Error) => {
      if (settled) return;
      finish(error);
      try { child.kill(); } catch { /* Preserve the cancellation/timeout result if termination fails. */ }
    };
    const cancel = () => stop(new DOMException("File selection cancelled.", "AbortError"));
    const timeout = setTimeout(() => stop(new Error("File selection timed out.")), 120_000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      if (settled) return;
      output += data;
      if (output.length > 65_536) stop(new Error("Invalid file selection response."));
    });
    child.once("error", () => finish(new Error("Could not open file selection.")));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) { finish(new Error("File selection requires an interactive Windows user session.")); return; }
      try {
        const selected: unknown = JSON.parse(output.trim());
        if (selected !== null && (typeof selected !== "string" || !/^[a-z]:\\/i.test(selected) || /[\0\r\n]/.test(selected))) {
          throw new Error("Invalid selected path");
        }
        finish(undefined, selected as string | null);
      } catch { finish(new Error("Invalid file selection response.")); }
    });
    if (signal?.aborted) cancel();
  });
}
