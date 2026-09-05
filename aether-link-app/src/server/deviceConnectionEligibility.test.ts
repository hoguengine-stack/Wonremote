import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApiServer } from "./apiServer";

describe("local connection eligibility with manually refreshed device lists", () => {
  it.each(["/api/sessions", "/api/sessions/secure-request", "/api/sessions/connect-code"])("checks the current target protocol at %s", async (route) => {
    const server = createApiServer([{
      id: "device-1", businessNumber: "123-45-67890", deviceNumber: "AGENT-1", deviceName: "POS",
      storeName: "Store", desktopName: "PC", status: "online", lastSeenAt: new Date().toISOString(),
      protocolVersion: 999, connectionCode: "123456",
    }]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(base + route, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "device-1", connectionCode: "123456" }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("protocol v999");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
