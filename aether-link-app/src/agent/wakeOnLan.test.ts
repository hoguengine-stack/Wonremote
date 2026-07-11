import { describe, expect, it } from "vitest";
import {
  buildWakeOnLanMagicPacket,
  normalizeWakeOnLanMac,
  parseWakeOnLanCommand,
} from "./wakeOnLan";

describe("Agent Wake-on-LAN relay", () => {
  it("validates and normalizes the server command MAC", () => {
    expect(parseWakeOnLanCommand("wake-on-lan aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(parseWakeOnLanCommand("wake-on-lan 00:00:00:00:00:00")).toBeNull();
    expect(parseWakeOnLanCommand("wake-on-lan invalid")).toBeNull();
    expect(normalizeWakeOnLanMac("aabbccddeeff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("builds the standard 102-byte UDP magic packet", () => {
    const packet = buildWakeOnLanMagicPacket("AA:BB:CC:DD:EE:FF");
    expect(packet).toHaveLength(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    for (let offset = 6; offset < packet.length; offset += 6) {
      expect(packet.subarray(offset, offset + 6)).toEqual(Buffer.from("AABBCCDDEEFF", "hex"));
    }
  });
});
