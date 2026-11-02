import { spawn } from "node:child_process";
import path from "node:path";
import { resolveAgentAppDir, resolveAgentPocPath } from "./agentPaths";

export async function selectFileToSend(
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (signal?.aborted) throw new DOMException("File selection cancelled.", "AbortError");
  if (platform !== "win32") throw new Error("File selection requires Windows.");
  const executable = resolveAgentPocPath(env, resolveAgentAppDir(env, process.cwd()));
  if (!path.win32.isAbsolute(executable)) throw new Error("Native file selector is unavailable.");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--select-file"],
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
