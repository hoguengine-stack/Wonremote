import dgram from "node:dgram";
import { normalizeWakeMac } from "../domain/wakeRelay";

export const normalizeWakeOnLanMac = normalizeWakeMac;

export function parseWakeOnLanCommand(action: string): string | null {
  const match = /^wake-on-lan\s+(.+)$/.exec(action.trim());
  return match ? normalizeWakeOnLanMac(match[1]) : null;
}

export function buildWakeOnLanMagicPacket(macAddress: string): Buffer {
  const normalized = normalizeWakeOnLanMac(macAddress);
  if (!normalized) {
    throw new Error("Wake-on-LAN requires a valid unicast MAC address.");
  }
  const macBytes = Buffer.from(normalized.replace(/:/g, ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => macBytes)]);
}

export async function sendWakeOnLanMagicPacket(
  macAddress: string,
  input: { address?: string; port?: number } = {},
): Promise<void> {
  const packet = buildWakeOnLanMagicPacket(macAddress);
  const address = input.address ?? "255.255.255.255";
  const port = input.port ?? 9;

  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // The socket may fail before bind completes.
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    socket.once("error", finish);
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, port, address, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
