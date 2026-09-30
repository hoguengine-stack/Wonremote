import { describe, expect, it, vi } from "vitest";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import type { AgentFirstRunInput, ManagedDevice } from "../domain/types";
import { createApiServer } from "../server/apiServer";
import { fetchAgentBusinessNumber, pollAgentCommands } from "./agentClient";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
vi.mock("../firebase/agentFirebase", () => ({isAgentFirebaseEnabled:()=>false}));
import {
  canRecoverMissingAgentRegistration,
  agentAuthBusinessNumber,
  synchronizeAgentBusinessNumber,
  reconcileAgentRegistration,
  recoverMissingAgentRegistration,
} from "./agentRegistrationRecovery";

const recoveredDevice: ManagedDevice = {
  businessNumber: "123-45-67890",
  desktopName: "DESKTOP-67890-AGENT-82220F6D",
  deviceName: "Agent AGENT-82220F6D",
  deviceNumber: "AGENT-82220F6D",
  id: "123-45-67890:AGENT-82220F6D",
  lastSeenAt: "2026-06-16T01:00:00.000Z",
  status: "online",
  storeName: "상호명 미설정",
};

describe("agent registration recovery", () => {
  it("propagates a real local Viewer edit through the owned command queue into persisted Agent config", async () => {
    const server = createApiServer([recoveredDevice]);
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = await mkdtemp(path.join(tmpdir(),"wonremote-business-sync-"));
    const configPath = path.join(dir,"agent-config.json");
    const config = {businessNumber:recoveredDevice.businessNumber,registeredDeviceId:recoveredDevice.id,installId:"82220F6D"};
    const identity = {apiBaseUrl,deviceId:recoveredDevice.id,installId:config.installId};
    const save = async (businessNumber: string) => {
      const response = await fetch(`${apiBaseUrl}/api/devices/${encodeURIComponent(recoveredDevice.id)}`, {method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({businessNumber})});
      expect(response.status).toBe(200); return response.json();
    };
    try {
      await save("9876543210");
      const commands = (await pollAgentCommands(identity)).commands;
      expect(commands.map(command=>command.action)).toEqual(["sync-business-number"]);
      await save("1112233333");
      const write = vi.fn(async value => writeFile(configPath,JSON.stringify(value)));
      await synchronizeAgentBusinessNumber(config,()=>fetchAgentBusinessNumber(identity),write);
      const persisted = JSON.parse(await readFile(configPath,"utf8"));
      expect(persisted).toMatchObject({businessNumber:"111-22-33333",authBusinessNumber:"123-45-67890",registeredDeviceId:recoveredDevice.id,installId:"82220F6D"});
      await synchronizeAgentBusinessNumber(config,()=>fetchAgentBusinessNumber(identity),write);
      expect(write).toHaveBeenCalledOnce();
      await expect(fetchAgentBusinessNumber({...identity,installId:"another-pc"})).rejects.toThrow();
      await pollAgentCommands(identity);
      await save("111-22-33333");
      expect((await pollAgentCommands(identity)).commands).toEqual([]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
      await rm(dir,{recursive:true,force:true});
    }
  });
  it("persists the changed display number but uses original credentials and identity on restart", async () => {
    const config = {businessNumber: recoveredDevice.businessNumber,installId:"82220F6D",registeredDeviceId:recoveredDevice.id};
    const writeConfig = vi.fn(async () => undefined);
    await synchronizeAgentBusinessNumber(config, async () => "9876543210", writeConfig);
    expect(config.businessNumber).toBe("987-65-43210");
    expect(agentAuthBusinessNumber(config)).toBe("123-45-67890");
    expect(config.registeredDeviceId).toBe(recoveredDevice.id);
    const registerFirstRun = vi.fn(async (_input: AgentFirstRunInput) => ({device:{...recoveredDevice,businessNumber:"987-65-43210"},devices:[]}));
    const afterRestart = await reconcileAgentRegistration(config, {nowIso:()=>"now",writeConfig,registerFirstRun});
    expect(registerFirstRun).toHaveBeenCalledWith(expect.objectContaining({businessNumber:"123-45-67890",installId:"82220F6D"}));
    expect(registerFirstRun.mock.calls[0][0]).not.toHaveProperty("previousDeviceId");
    expect(afterRestart).toMatchObject({businessNumber:"987-65-43210",authBusinessNumber:"123-45-67890",registeredDeviceId:recoveredDevice.id});
    const load = vi.fn(async () => "987-65-43210");
    await synchronizeAgentBusinessNumber(config, load, writeConfig);
    expect(writeConfig).toHaveBeenCalledTimes(2);
  });
  it("keeps config unchanged when sync read, validation or persistence fails", async () => {
    const config = {businessNumber:recoveredDevice.businessNumber,installId:"82220F6D"};
    const write = vi.fn(async () => { throw new Error("Disk full"); });
    await expect(synchronizeAgentBusinessNumber(config, async () => { throw new Error("Quota"); }, write)).rejects.toThrow("Quota");
    await expect(synchronizeAgentBusinessNumber(config, async () => "123", write)).rejects.toThrow("10");
    expect(write).not.toHaveBeenCalled();
    await expect(synchronizeAgentBusinessNumber(config, async () => "9876543210", write)).rejects.toThrow("Disk full");
    expect(config).toEqual({businessNumber:recoveredDevice.businessNumber,installId:"82220F6D"});
  });
  it("re-registers a Firebase device from the existing local config without prompting", async () => {
    const registerFirstRun = vi.fn(async () => ({
      device: recoveredDevice,
      devices: [recoveredDevice],
    }));
    const writeConfig = vi.fn(async () => undefined);

    const recovered = await recoverMissingAgentRegistration(
      {
        apiUrl: "http://127.0.0.1:8787",
        businessNumber: "123-45-67890",
        desktopName: "STORE-POS-01",
        installId: "82220F6D",
        registeredDeviceId: "123-45-67890:AGENT-82220F6D",
        version: "0.1.16",
      },
      {
        nowIso: () => "2026-06-16T01:00:00.000Z",
        registerFirstRun,
        writeConfig,
      },
    );

    expect(registerFirstRun).toHaveBeenCalledWith({
      businessNumber: "123-45-67890",
      desktopName: "STORE-POS-01",
      installId: "82220F6D",
      password: "1234",
      version: WONREMOTE_APP_VERSION,
    });
    expect(recovered).toMatchObject({
      businessNumber: "123-45-67890",
      desktopName: "STORE-POS-01",
      installId: "82220F6D",
      registeredAt: "2026-06-16T01:00:00.000Z",
      registeredDeviceId: "123-45-67890:AGENT-82220F6D",
      version: WONREMOTE_APP_VERSION,
    });
    expect(writeConfig).toHaveBeenCalledWith(recovered);
  });

  it("refuses recovery when the local config does not contain enough identity", () => {
    expect(canRecoverMissingAgentRegistration({ installId: "82220F6D" })).toBe(false);
    expect(canRecoverMissingAgentRegistration({ businessNumber: "123-45-67890", installId: "82220F6D" })).toBe(true);
  });

  it("replaces a stale registered device ID with the ID derived from the local install ID", async () => {
    const registerFirstRun = vi.fn(async () => ({
      device: recoveredDevice,
      devices: [recoveredDevice],
    }));
    const writeConfig = vi.fn(async () => undefined);

    const reconciled = await reconcileAgentRegistration(
      {
        businessNumber: "123-45-67890",
        installId: "82220F6D",
        registeredDeviceId: "123-45-67890:AGENT-CBFFB65C",
      },
      {
        nowIso: () => "2026-08-12T00:00:00.000Z",
        registerFirstRun,
        writeConfig,
      },
    );

    expect(reconciled.registeredDeviceId).toBe("123-45-67890:AGENT-82220F6D");
    expect(registerFirstRun).toHaveBeenCalledWith(expect.objectContaining({
      previousDeviceId: "123-45-67890:AGENT-CBFFB65C",
    }));
    expect(writeConfig).toHaveBeenCalledWith(reconciled);
  });
});
