import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveAgentDownloadDir } from "./fileSafety";

export async function openAgentDownloadFolder(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") throw new Error("Opening the receive folder requires Windows.");
  const root = resolveAgentDownloadDir(env);
  if (!(await stat(root)).isDirectory()) throw new Error("Receive folder is not a directory.");
  const windowsRoot = env.SystemRoot;
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) throw new Error("Windows directory is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(path.win32.join(windowsRoot, "explorer.exe"), [root], {
      shell: false, stdio: "ignore", windowsHide: false,
    });
    const onError = (error: Error) => { child.removeListener("spawn", onSpawn); reject(error); };
    const onSpawn = () => { child.removeListener("error", onError); child.unref(); resolve(); };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}
