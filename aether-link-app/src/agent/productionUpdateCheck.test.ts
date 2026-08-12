import { describe, expect, it, vi } from "vitest";
import { checkProductionUpdate } from "./productionUpdateCheck";

describe("production update check", () => {
  it("reports an available signed update without downloading it", async () => {
    const loadMetadata = vi.fn(async () => ({
      forceUpdate: false,
      latestVersion: "0.1.61",
    }));

    await expect(checkProductionUpdate("0.1.60", loadMetadata as any)).resolves.toEqual({
      available: true,
      latestVersion: "0.1.61",
    });
  });

  it("keeps a current Viewer current unless the release forces an update", async () => {
    await expect(checkProductionUpdate("0.1.60", async () => ({
      forceUpdate: false,
      latestVersion: "0.1.60",
    }) as any)).resolves.toEqual({
      available: false,
      latestVersion: "0.1.60",
    });

    await expect(checkProductionUpdate("0.1.60", async () => ({
      forceUpdate: true,
      latestVersion: "0.1.60",
    }) as any)).resolves.toEqual({
      available: true,
      latestVersion: "0.1.60",
    });
  });
});
