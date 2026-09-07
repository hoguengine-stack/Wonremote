import {expect,it,vi} from "vitest";
import {createRemoteUpdateRequest} from "./remoteUpdateRequest";

it("runs once, deduplicates deliveries, rejects expired requests, and adds no idle polling", async () => {
  const now=1700000000000;
  const update=vi.fn(async()=>{});
  const gate=createRemoteUpdateRequest(()=>false);
  await gate.receive(`request-update ${now}`,update,now);
  await gate.receive(`request-update ${now}`,update,now);
  await gate.receive(`request-update ${now+1}`,update,now+86400000);
  await gate.drain();
  expect(update).toHaveBeenCalledTimes(1);
});
it("cancels pending work on shutdown", async()=>{
  const gate=createRemoteUpdateRequest(()=>false);
  const update=vi.fn(async()=>{});
  gate.defer(update);
  gate.dispose();
  await gate.drain();
  gate.defer(update);
  await gate.receive("request-update 1700000000000",update,1700000000000);
  expect(update).not.toHaveBeenCalled();
});
it("defers until session end, blocks overlapping requests and permits explicit retry after failure",async()=>{
  let active=true;
  const gate=createRemoteUpdateRequest(()=>active);
  let release!:()=>void;
  const update=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  const now=1700000000000;
  await gate.receive(`request-update ${now}`,update,now);
  expect(update).not.toHaveBeenCalled();
  active=false;
  const draining=gate.drain();
  expect(await gate.receive(`request-update ${now+1}`,update,now+1)).toBe(false);
  release(); await draining;
  await expect(gate.receive(`request-update ${now+2}`,async()=>{throw Error("offline");},now+2)).rejects.toThrow("offline");
  await gate.receive(`request-update ${now+3}`,async()=>{},now+3);
  expect(update).toHaveBeenCalledTimes(1);
});
