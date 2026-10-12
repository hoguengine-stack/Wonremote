import { spawn } from "node:child_process";

export function protectDeviceAccessData(value: string, decrypt = false): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("장비 접속 잠금은 Windows Agent에서 지원합니다."));
  const operation = decrypt ? "Unprotect" : "Protect";
  const input = decrypt ? "[Convert]::FromBase64String([Console]::In.ReadToEnd())" : "[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())";
  const output = decrypt ? "[Text.Encoding]::UTF8.GetString($result)" : "[Convert]::ToBase64String($result)";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=${input}; $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${output})`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {windowsHide:true, stdio:["pipe", "pipe", "ignore"]});
    let result = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("접속 잠금 설정 보호 처리 시간이 초과되었습니다.")); }, 10_000);
    child.stdout.on("data", chunk => {
      result += chunk.toString("utf8");
      if (result.length > 64 * 1024) { child.kill(); }
    });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Windows 접속 잠금 설정 보호를 시작하지 못했습니다.")); });
    child.stdin.on("error", () => { child.kill(); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || result.length > 64 * 1024) reject(new Error("Windows 접속 잠금 설정 보호에 실패했습니다."));
      else resolve(result);
    });
    child.stdin.end(value);
  });
}
