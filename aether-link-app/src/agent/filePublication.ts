import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAgentAppDir, resolveAgentPocPath } from "./agentPaths";

const execute = promisify(execFile);

export async function publishFileWithoutOverwrite(source: string, target: string): Promise<void> {
  const executable = resolveAgentPocPath(process.env, resolveAgentAppDir(process.env, process.cwd()));
  const { stdout } = await execute(executable, ["--publish-received-file", source, target], {
    windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096, encoding: "utf8",
  });
  const result = JSON.parse(stdout);
  if (result?.ok === true) return;
  const collision = result?.win32Error === 80 || result?.win32Error === 183;
  throw Object.assign(new Error(collision ? "Destination already exists" : "Native file publication failed"), {
    code: collision ? "EEXIST" : "EIO",
  });
}
