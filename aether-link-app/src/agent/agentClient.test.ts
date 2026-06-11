import { describe, expect, it, vi } from "vitest";
import { pollAgentCommands, sendAgentHeartbeat } from "./agentClient";

describe("agent client", () => {
  it("sends a heartbeat with the registered device id and install id", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          device: {
            id: "123-45-67890:AGENT-ABC123",
            status: "online",
          },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });

    const result = await sendAgentHeartbeat({
      apiBaseUrl: "http://127.0.0.1:8787",
      deviceId: "123-45-67890:AGENT-ABC123",
      fetchImpl,
      installId: "agent-abc123",
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/agent/heartbeat", {
      body: JSON.stringify({
        deviceId: "123-45-67890:AGENT-ABC123",
        installId: "agent-abc123",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(result.device).toMatchObject({
      id: "123-45-67890:AGENT-ABC123",
      status: "online",
    });
  });

  it("polls queued viewer commands for the registered agent", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          commands: [
            {
              action: "마우스 클릭",
              createdAt: "2026-06-11T02:30:00.000Z",
              deviceId: "123-45-67890:AGENT-ABC123",
              id: "cmd-1",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });

    const result = await pollAgentCommands({
      apiBaseUrl: "http://127.0.0.1:8787",
      deviceId: "123-45-67890:AGENT-ABC123",
      fetchImpl,
      installId: "agent-abc123",
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/agent/commands", {
      body: JSON.stringify({
        deviceId: "123-45-67890:AGENT-ABC123",
        installId: "agent-abc123",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(result.commands).toEqual([
      expect.objectContaining({
        action: "마우스 클릭",
        id: "cmd-1",
      }),
    ]);
  });

  it("preserves heartbeat HTTP status on API errors", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "device not found" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    });

    await expect(
      sendAgentHeartbeat({
        apiBaseUrl: "http://127.0.0.1:8787",
        deviceId: "missing-device",
        fetchImpl,
        installId: "agent-missing",
      }),
    ).rejects.toMatchObject({
      message: "device not found",
      status: 404,
    });
  });

  it("preserves command poll HTTP status on API errors", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "device not found" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    });

    await expect(
      pollAgentCommands({
        apiBaseUrl: "http://127.0.0.1:8787",
        deviceId: "missing-device",
        fetchImpl,
        installId: "agent-missing",
      }),
    ).rejects.toMatchObject({
      message: "device not found",
      status: 404,
    });
  });
});
