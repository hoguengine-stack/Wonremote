import { describe, expect, it, vi } from "vitest";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import type { AgentFirstRunInput, ManagedDevice } from "../domain/types";
import { createApiServer } from "../server/apiServer";
import { fetchAgentBusinessNumber, fetchAgentZookNumber, pollAgentCommands, sendAgentHeartbeat } from "./agentClient";
import { synchronizeZookNumber } from "./zookSettings";
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
  it("edits running Agent metadata through owned HTTP without re-registering or changing auth identity", async () => {
    const server=createApiServer([recoveredDevice]);
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const apiBaseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const identity={apiBaseUrl,deviceId:recoveredDevice.id,installId:"82220F6D"};
    const save=(input:unknown)=>fetch(`${apiBaseUrl}/api/agent/device`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({...identity,...input as object})});
    try {
      expect((await save({businessNumber:"9876543210",storeName:"실행 중 수정",deviceName:"키오스크",installId:"wrong"})).status).toBe(400);
      expect((await pollAgentCommands(identity)).commands).toEqual([]);
      const input={businessNumber:"9876543210",storeName:"실행 중 수정",deviceName:"키오스크",notes:"do not change",ownerUid:"attacker"};
      const response=await save(input); expect(response.status).toBe(200);
      expect((await response.json()).device).toMatchObject({id:recoveredDevice.id,deviceNumber:recoveredDevice.deviceNumber,businessNumber:"987-65-43210",storeName:"실행 중 수정",deviceName:"키오스크"});
      expect((await pollAgentCommands(identity)).commands.map(c=>c.action)).toEqual(["sync-business-number"]);
      const config={businessNumber:recoveredDevice.businessNumber,registeredDeviceId:recoveredDevice.id,installId:identity.installId};
      const write=vi.fn(async()=>{});
      await synchronizeAgentBusinessNumber(config,()=>fetchAgentBusinessNumber(identity),write);
      expect(config).toMatchObject({registeredDeviceId:recoveredDevice.id,businessNumber:"987-65-43210",authBusinessNumber:"123-45-67890"});
      await save(input);expect((await pollAgentCommands(identity)).commands).toEqual([]);
      expect((await save({...input,businessNumber:"invalid"})).status).toBe(400);
      const loaded=await fetch(`${apiBaseUrl}/api/agent/device`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(identity)});
      const device=(await loaded.json()).device;
      expect(device.businessNumber).toBe("987-65-43210"); expect(device.notes).not.toBe("do not change");
      expect(device).not.toHaveProperty("ownerUid");
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it("delivers the latest ZOOK number over the real local HTTP command/owned-device/heartbeat path", async () => {
    const server = createApiServer([recoveredDevice]);
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const identity = {apiBaseUrl,deviceId:recoveredDevice.id,installId:"82220F6D"};
    const save = (zookNumber: string) => fetch(`${apiBaseUrl}/api/devices/${encodeURIComponent(recoveredDevice.id)}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({zookNumber})});
    let applied = "";
    const apply = vi.fn(async number=>{applied=number;});
    try {
      expect((await save("00123456")).status).toBe(200);
      expect((await pollAgentCommands(identity)).commands.map(c=>c.action)).toEqual(["configure-zook"]);
      expect((await save("00876543")).status).toBe(200);
      const report = async (zookResult: {appliedNumber?:string;error?:string}) => {
        const result = await sendAgentHeartbeat({...identity,zookResult});
        expect(result.device).toMatchObject({id:recoveredDevice.id,businessNumber:recoveredDevice.businessNumber,zookAppliedNumber:"00876543"});
      };
      const deps = {load:()=>fetchAgentZookNumber(identity),readApplied:async()=>applied,apply,report};
      expect(await synchronizeZookNumber(deps)).toBe(true);
      expect(apply).toHaveBeenCalledWith("00876543");
      await synchronizeZookNumber(deps);
      expect(apply).toHaveBeenCalledTimes(1);
      await expect(fetchAgentZookNumber({...identity,installId:"another-pc"})).rejects.toThrow();
      await pollAgentCommands(identity);
      await save("00876543");
      expect((await pollAgentCommands(identity)).commands).toEqual([]);
      expect((await save("invalid")).status).toBe(404);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
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
