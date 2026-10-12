import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeZookNumber } from "../domain/zookNumber";

const run = promisify(execFile);
export async function readLocalZookNumber(configPath: string): Promise<string> {
  try { return normalizeZookNumber(JSON.parse(await readFile(path.join(path.dirname(configPath), "zook-number.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

export async function applyZookNumber(number: string): Promise<void> {
  normalizeZookNumber(number);
  if (!number || process.platform !== "win32") throw new Error("ZOOK 설정은 Windows Agent에서만 사용할 수 있습니다.");
  const host = process.env.WONREMOTE_HOST_EXE_PATH;
  if (!host || !path.isAbsolute(host) || path.basename(host).toLowerCase() !== "wonremote-viewer.exe") throw new Error("ZOOK 설정을 지원하는 설치형 Agent가 필요합니다.");
  try {
    const result = await run(host, ["--agent", "--configure-zook", number], { windowsHide: true, timeout: 260_000, maxBuffer: 8192 });
    if (JSON.parse(result.stdout).number !== `014-${number.slice(0,4)}-${number.slice(4)}`) throw new Error("ZOOK 설정 결과가 일치하지 않습니다.");
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr?.slice(0,500) || (error instanceof Error ? error.message : String(error)));
  }
}

export async function synchronizeZookNumber(deps: {
  load: () => Promise<string>; readApplied: () => Promise<string>; apply: (number: string) => Promise<void>;
  report: (result: { appliedNumber?: string; error?: string }) => Promise<void>;
}): Promise<boolean> {
  const number = normalizeZookNumber(await deps.load());
  if (!number) return false; // Clearing metadata does not cancel an existing standby.
  const appliedNumber = await deps.readApplied();
  if (number === appliedNumber) { await deps.report({appliedNumber, error:""}); return false; }
  try { await deps.apply(number); }
  catch (error) { await deps.report({appliedNumber, error: (error instanceof Error ? error.message : String(error)).slice(0,500)}); return false; }
  await deps.report({appliedNumber: number, error: ""});
  return true;
}
