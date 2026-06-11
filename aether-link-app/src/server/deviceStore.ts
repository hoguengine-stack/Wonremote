import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManagedDevice } from "../domain/types";

export interface DeviceStore {
  readDevices: () => Promise<ManagedDevice[]>;
  writeDevices: (devices: ManagedDevice[]) => Promise<void>;
}

export function createMemoryDeviceStore(initialDevices: ManagedDevice[] = []): DeviceStore {
  let devices = initialDevices;
  return {
    async readDevices() {
      return devices;
    },
    async writeDevices(nextDevices) {
      devices = nextDevices;
    },
  };
}

export function createFileDeviceStore(filePath: string): DeviceStore {
  return {
    async readDevices() {
      try {
        const content = await readFile(filePath, "utf8");
        const payload = JSON.parse(content) as { devices?: ManagedDevice[] };
        return Array.isArray(payload.devices) ? payload.devices : [];
      } catch (error) {
        if (isNotFoundError(error)) {
          return [];
        }
        throw error;
      }
    },
    async writeDevices(devices) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify({ devices }, null, 2)}\n`, "utf8");
    },
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
