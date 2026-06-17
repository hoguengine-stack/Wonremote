import { afterEach, describe, expect, it, vi } from "vitest";
import { pollAgentCommands, postAgentSessionApproval, sendAgentHeartbeat } from "./agentClient";

const firebaseMock = vi.hoisted(() => ({
  enabled: false,
  pollAgentCommandsWithFirebase: vi.fn(),
  sendAgentHeartbeatWithFirebase: vi.fn(),
}));

vi.mock("../firebase/agentFirebase", async (importOriginal) => {
  const original = await importOriginal<typeof import("../firebase/agentFirebase")>();
  return {
    ...original,
    isAgentFirebaseEnabled: () => firebaseMock.enabled,
    pollAgentCommandsWithFirebase: firebaseMock.pollAgentCommandsWithFirebase,
    sendAgentHeartbeatWithFirebase: firebaseMock.sendAgentHeartbeatWithFirebase,
  };
});

describe("agent client", () => {
  afterEach(() => {
    firebaseMock.enabled = false;
    firebaseMock.pollAgentCommandsWithFirebase.mockReset();
    firebaseMock.sendAgentHeartbeatWithFirebase.mockReset();
  });

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

  it("sends stream diagnostics with heartbeat payloads", async () => {
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

    await sendAgentHeartbeat({
      apiBaseUrl: "http://127.0.0.1:8787",
      deviceId: "123-45-67890:AGENT-ABC123",
      fetchImpl,
      installId: "agent-abc123",
      streamDiagnostics: {
        backend: "gdi",
        desired: true,
        running: false,
        restartCount: 2,
        loopSleepMs: 125,
        outputIndex: 1,
        lastError: "DXGI access denied",
        transport: "firestore-fallback",
      },
    } as any);

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/agent/heartbeat", {
      body: JSON.stringify({
        deviceId: "123-45-67890:AGENT-ABC123",
        installId: "agent-abc123",
        streamDiagnostics: {
          backend: "gdi",
          desired: true,
          running: false,
          restartCount: 2,
          loopSleepMs: 125,
          outputIndex: 1,
          lastError: "DXGI access denied",
          transport: "firestore-fallback",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
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

  it("routes heartbeat through Firebase without touching the local API", async () => {
    firebaseMock.enabled = true;
    firebaseMock.sendAgentHeartbeatWithFirebase.mockResolvedValue({
      device: {
        id: "123-45-67890:AGENT-ABC123",
        status: "online",
      },
    });
    const fetchImpl = vi.fn();

    const result = await sendAgentHeartbeat({
      apiBaseUrl: "http://127.0.0.1:8787",
      deviceId: "123-45-67890:AGENT-ABC123",
      fetchImpl,
      installId: "agent-abc123",
      version: "0.1.25",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(firebaseMock.sendAgentHeartbeatWithFirebase).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "123-45-67890:AGENT-ABC123",
        installId: "agent-abc123",
        version: "0.1.25",
      }),
    );
    expect(result.device).toMatchObject({
      id: "123-45-67890:AGENT-ABC123",
      status: "online",
    });
  });

  it("routes command polling through Firebase without touching the local API", async () => {
    firebaseMock.enabled = true;
    firebaseMock.pollAgentCommandsWithFirebase.mockResolvedValue({
      commands: [
        {
          action: "start-stream",
          createdAt: "2026-06-16T01:00:00.000Z",
          deviceId: "123-45-67890:AGENT-ABC123",
          id: "cmd-firebase",
        },
      ],
    });
    const fetchImpl = vi.fn();

    const result = await pollAgentCommands({
      apiBaseUrl: "http://127.0.0.1:8787",
      deviceId: "123-45-67890:AGENT-ABC123",
      fetchImpl,
      installId: "agent-abc123",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(firebaseMock.pollAgentCommandsWithFirebase).toHaveBeenCalledWith({
      deviceId: "123-45-67890:AGENT-ABC123",
      installId: "agent-abc123",
    });
    expect(result.commands).toEqual([
      expect.objectContaining({
        action: "start-stream",
        id: "cmd-firebase",
      }),
    ]);
  });

  it("does not post approval decisions to the local API in Firebase mode", async () => {
    firebaseMock.enabled = true;
    const fetchImpl = vi.fn();

    await postAgentSessionApproval({
      apiBaseUrl: "http://127.0.0.1:8787",
      approved: true,
      fetchImpl,
      sessionId: "session-123-45-67890:AGENT-ABC123",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
