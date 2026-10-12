import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDeviceAccessLock } from "./deviceAccessLock";
import { encryptDeviceAccessRequest, type DeviceAccessOperation } from "../domain/deviceAccessLock";

describe("installed-platform device access boundary", () => {
  it.runIf(process.platform === "win32")("encrypts credentials, protects storage, preserves locks, rejects wrong passwords and rolls back failed publication", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wonremote-access-test-"));
    const file = path.join(directory, "lock.dat");
    try {
      let lock = await AgentDeviceAccessLock.load(file, "device-1");
      const request = async (operation: DeviceAccessOperation, password: string, newPassword?: string) => encryptDeviceAccessRequest({
        id:crypto.randomUUID(), deviceId:"device-1", ownerUid:"viewer-1", operation,
        sessionId:operation === "connect" ? "session-1" : "", lockVersion:lock.publicState.version,
      }, lock.publicState.publicKey, {password, newPassword});
      expect(lock.publicState.enabled).toBe(false);
      const initial = await request("set", "", "pass-1234");
      expect(JSON.stringify(initial)).not.toContain("pass-1234");
      await lock.authorize(initial);
      const first = lock.publicState;
      expect(first.enabled).toBe(true);
      expect(await readFile(file, "utf8")).not.toContain("PRIVATE KEY");
      expect(await readFile(file, "utf8")).not.toContain("pass-1234");
      lock = await AgentDeviceAccessLock.load(file, "device-1");
      expect(lock.publicState).toEqual(first);
      await expect(lock.authorize(await request("connect", "wrong"))).rejects.toThrow("일치하지");
      expect(lock.publicState).toEqual(first);
      const connect = await request("connect", "pass-1234");
      await expect(lock.authorize({...connect, ownerUid:"another-viewer"})).rejects.toThrow("검증하지");
      await expect(lock.authorize(connect)).resolves.toEqual(first);
      await expect(lock.authorize(await request("set", "pass-1234", "replacement"), Date.now(), async () => {throw Error("publish failed");})).rejects.toThrow("publish failed");
      expect(lock.publicState).toEqual(first);
      lock = await AgentDeviceAccessLock.load(file, "device-1");
      await expect(lock.authorize(await request("connect", "pass-1234"))).resolves.toEqual(first);
      await expect(lock.authorize(await request("reset", "incorrect administrator", "replacement"))).rejects.toThrow("일치하지");
      if (process.env.WONREMOTE_TEST_RECOVERY_PASSWORD) {
        await lock.authorize(await request("reset", process.env.WONREMOTE_TEST_RECOVERY_PASSWORD, "replacement"));
        expect(lock.publicState.version).not.toBe(first.version);
        await expect(lock.authorize(await request("connect", "pass-1234"))).rejects.toThrow("일치하지");
        await lock.authorize(await request("disable", "replacement"));
      } else {
        await lock.authorize(await request("disable", "pass-1234"));
      }
      expect(lock.publicState.enabled).toBe(false);
      const changed = lock.publicState;
      await expect(lock.authorize(await request("set", "", "x"))).rejects.toThrow("4~64");
      expect(lock.publicState).toEqual(changed);
      for (let attempt = 0; attempt < 5; attempt++) await expect(lock.authorize(await request("reset", "incorrect", "replacement"))).rejects.toThrow();
      await expect(lock.authorize(await request("set", "", "replacement"))).rejects.toThrow("잠시 후");
      await writeFile(file, "corrupt protected storage");
      await expect(AgentDeviceAccessLock.load(file, "device-1")).rejects.toThrow();
    } finally {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("wonremote-access-test-")) throw Error("Unexpected owned test path");
      await rm(resolved, {recursive:true, force:true});
    }
  }, 90_000);
});
