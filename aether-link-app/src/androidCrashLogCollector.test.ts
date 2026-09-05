import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "mobile/android/collect-android-crash-log.ps1");
const launcher = path.join(root, "mobile/android/run-android-crash-log.cmd");

describe("Android crash log collector", () => {
  it("runs its device-free capture setup and cleanup check", () => {
    const output = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", script, "-SelfTest"], {
      encoding: "utf8", windowsHide: true,
    });
    expect(output).toContain("Self-test passed.");
  });

  it("keeps the launch console open when the capture script reports an error", () => {
    const command = readFileSync(launcher, "utf8");
    expect(command).toContain("-NoExit");
    expect(command).toContain("pause");
    expect(command).toContain("collect-android-crash-log.ps1");
    expect(command).toContain("raw.githubusercontent.com/hoguengine-stack/Wonremote/main/mobile/android/collect-android-crash-log.ps1");
    expect(command).toContain("Downloading current WonRemote Android crash collector");
    expect(command).toContain('del /q "%SCRIPT%"');
    expect(command).toContain("if errorlevel 1");
  });

  it("downloads the official Platform-Tools package when ADB is absent", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("https://dl.google.com/android/repository/platform-tools-latest-windows.zip");
    expect(source).toContain("Expand-Archive");
    expect(source).toContain("C:\\Android\\sdk\\platform-tools\\adb.exe");
    expect(source).toContain("Get-FirstExistingPath");
    expect(source).toContain("Get-AuthorizedDeviceSerial");
  });
});
