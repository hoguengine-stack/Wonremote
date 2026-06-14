import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "./apiServer";
import { createFileDeviceStore } from "./deviceStore";
import type { ManagedDevice } from "../domain/types";
import { nextPatchVersion } from "../domain/versioning";

describe("WonRemote local API server", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl = "";

  beforeEach(async () => {
    server = createApiServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("reports health before stateful routes are initialized", async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("allows temporary local viewer ports through CORS preflight", async () => {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
      headers: {
        "access-control-request-headers": "content-type",
        "access-control-request-method": "POST",
        origin: "http://127.0.0.1:5174",
      },
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5174");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("rejects invalid admin login and accepts the development admin", async () => {
    const rejected = await postJson("/api/admin/login", {
      username: "admin",
      password: "wrong",
    });
    expect(rejected.status).toBe(401);

    const accepted = await postJson("/api/admin/login", {
      username: "admin",
      password: "admin1234",
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
  });

  it("blocks wrong agent password before registering a device", async () => {
    const rejected = await postJson("/api/agent/connect", {
      businessNumber: "1234567890",
      password: "wrong",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "카운터",
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "Agent 비밀번호가 올바르지 않습니다.",
    });

    const devices = await fetch(`${baseUrl}/api/devices`);
    expect(await devices.json()).toEqual({ devices: [] });
  });

  it("registers a first-run agent and exposes it to the viewer device list", async () => {
    const registered = await postJson("/api/agent/first-run", {
      businessNumber: "2223344444",
      password: "1234",
      installId: "agent-pos-77",
    });

    expect(registered.status).toBe(200);
    const registeredBody = await registered.json();
    expect(registeredBody.device).toMatchObject({
      id: "222-33-44444:AGENT-POS-77",
      storeName: "사업자 222-33-44444",
      deviceNumber: "AGENT-POS-77",
      deviceName: "Agent AGENT-POS-77",
      status: "online",
    });

    const devices = await fetch(`${baseUrl}/api/devices`);
    expect(await devices.json()).toMatchObject({
      devices: [expect.objectContaining({ id: "222-33-44444:AGENT-POS-77" })],
    });
  });

  it("rejects a first-run agent with a wrong password", async () => {
    const rejected = await postJson("/api/agent/first-run", {
      businessNumber: "2223344444",
      password: "wrong",
      installId: "agent-pos-77",
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "Agent 비밀번호가 올바르지 않습니다.",
    });

    const devices = await fetch(`${baseUrl}/api/devices`);
    expect(await devices.json()).toEqual({ devices: [] });
  });

  it("registers an agent, opens a connected session, and records input immediately", async () => {
    const connected = await postJson("/api/agent/connect", {
      businessNumber: "1234567890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "카운터",
    });

    expect(connected.status).toBe(200);
    const connectedBody = await connected.json();
    expect(connectedBody.devices).toHaveLength(1);
    expect(connectedBody.session).toMatchObject({
      deviceId: "123-45-67890:POS-01",
      state: "connected",
    });

    const input = await postJson(`/api/sessions/${connectedBody.session.id}/input`, {
      action: "mouse-click",
    });

    expect(input.status).toBe(200);
    const inputBody = await input.json();
    expect(inputBody.inputLog[0]).toContain("mouse-click");
  });

  it("queues viewer input events for the registered agent and clears them after polling", async () => {
    const connected = await postJson("/api/agent/first-run", {
      businessNumber: "1234567890",
      password: "1234",
      installId: "agent-command-01",
    });
    const connectedBody = await connected.json();

    const session = await postJson("/api/sessions", {
      deviceId: connectedBody.device.id,
    });
    const sessionBody = await session.json();

    const prePoll = await postJson("/api/agent/commands", {
      deviceId: connectedBody.device.id,
      installId: "agent-command-01",
    });
    expect(prePoll.status).toBe(200);
    expect(await prePoll.json()).toMatchObject({
      commands: [
        {
          action: "start-stream",
          deviceId: "123-45-67890:AGENT-COMMAND-01",
        },
      ],
    });

    const input = await postJson(`/api/sessions/${sessionBody.session.id}/input`, {
      action: "마우스 클릭",
    });
    expect(input.status).toBe(200);

    const polled = await postJson("/api/agent/commands", {
      deviceId: connectedBody.device.id,
      installId: "agent-command-01",
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({
      commands: [
        {
          action: "마우스 클릭",
          deviceId: "123-45-67890:AGENT-COMMAND-01",
        },
      ],
    });

    const emptyPoll = await postJson("/api/agent/commands", {
      deviceId: connectedBody.device.id,
      installId: "agent-command-01",
    });
    expect(await emptyPoll.json()).toEqual({ commands: [] });
  });

  it("allows session data channels immediately after opening an owned online agent", async () => {
    const registered = await postJson("/api/agent/first-run", {
      businessNumber: "5556677777",
      password: "1234",
      installId: "agent-pending-gate",
    });
    const registeredBody = await registered.json();

    const session = await postJson("/api/sessions", {
      deviceId: registeredBody.device.id,
    });
    const sessionBody = await session.json();
    const encodedSessionId = encodeURIComponent(sessionBody.session.id);

    const chat = await postJson(`/api/sessions/${encodedSessionId}/chat`, {
      message: "allowed",
      sender: "viewer",
    });
    expect(chat.status).toBe(200);

    const clipboard = await postJson(`/api/sessions/${encodedSessionId}/clipboard`, {
      text: "allowed",
      sender: "viewer",
    });
    expect(clipboard.status).toBe(200);

    const file = await postJson(`/api/sessions/${encodedSessionId}/files`, {
      filename: "allowed.txt",
      fileData: Buffer.from("allowed").toString("base64"),
    });
    expect(file.status).toBe(200);

    const tiles = await postJson(`/api/sessions/${encodedSessionId}/tiles`, {
      width: 32,
      height: 32,
      tiles: [],
    });
    expect(tiles.status).toBe(200);
  });

  it("preserves file chunk metadata until the agent fetches it", async () => {
    const registered = await postJson("/api/agent/first-run", {
      businessNumber: "4445566666",
      password: "1234",
      installId: "agent-file-chunks",
    });
    const registeredBody = await registered.json();
    const session = await postJson("/api/sessions", {
      deviceId: registeredBody.device.id,
    });
    const sessionBody = await session.json();
    const encodedSessionId = encodeURIComponent(sessionBody.session.id);

    const first = await postJson(`/api/sessions/${encodedSessionId}/files`, {
      filename: "chunked.txt",
      fileData: Buffer.from("hello ").toString("base64"),
      transferId: "transfer-1",
      chunkIndex: 0,
      totalChunks: 2,
      isLast: false,
    });
    const second = await postJson(`/api/sessions/${encodedSessionId}/files`, {
      filename: "chunked.txt",
      fileData: Buffer.from("world").toString("base64"),
      transferId: "transfer-1",
      chunkIndex: 1,
      totalChunks: 2,
      isLast: true,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const fetched = await fetch(`${baseUrl}/api/sessions/${encodedSessionId}/files`);
    expect(await fetched.json()).toMatchObject({
      files: [
        expect.objectContaining({ transferId: "transfer-1", chunkIndex: 0, totalChunks: 2, isLast: false }),
        expect.objectContaining({ transferId: "transfer-1", chunkIndex: 1, totalChunks: 2, isLast: true }),
      ],
    });

    const empty = await fetch(`${baseUrl}/api/sessions/${encodedSessionId}/files`);
    expect(await empty.json()).toEqual({ files: [] });
  });

  it("rejects file transfers whose declared total size exceeds 500MB", async () => {
    const registered = await postJson("/api/agent/first-run", {
      businessNumber: "4445577777",
      password: "1234",
      installId: "agent-file-limit",
    });
    const registeredBody = await registered.json();
    const session = await postJson("/api/sessions", {
      deviceId: registeredBody.device.id,
    });
    const sessionBody = await session.json();
    const encodedSessionId = encodeURIComponent(sessionBody.session.id);

    const accepted = await postJson(`/api/sessions/${encodedSessionId}/files`, {
      filename: "accepted.bin",
      fileData: Buffer.from("chunk").toString("base64"),
      transferId: "transfer-under-limit",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 500 * 1024 * 1024,
      isLast: true,
    });
    const rejected = await postJson(`/api/sessions/${encodedSessionId}/files`, {
      filename: "too-large.bin",
      fileData: Buffer.from("chunk").toString("base64"),
      transferId: "transfer-over-limit",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 500 * 1024 * 1024 + 1,
      isLast: true,
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: expect.stringContaining("500MB"),
    });
  });

  it("opens a new session for an already registered device", async () => {
    const connected = await postJson("/api/agent/connect", {
      businessNumber: "1234567890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-01",
      deviceName: "카운터",
    });
    const connectedBody = await connected.json();

    const reopened = await postJson("/api/sessions", {
      deviceId: connectedBody.session.deviceId,
    });

    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      session: {
        deviceId: "123-45-67890:POS-01",
        state: "connected",
      },
      inputLog: [expect.stringContaining("세션 연결 완료")],
    });
  });


  it("persists registered devices across API server restarts", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "wonremote-api-"));
    const storePath = path.join(tempDir, "devices.json");
    try {
      await closeServer();
      server = createApiServer({
        deviceStore: createFileDeviceStore(storePath),
      });
      await listen();

      const registered = await postJson("/api/agent/first-run", {
        businessNumber: "5556677777",
        password: "1234",
        installId: "agent-restart-01",
      });
      expect(registered.status).toBe(200);

      await closeServer();
      server = createApiServer({
        deviceStore: createFileDeviceStore(storePath),
      });
      await listen();

      const devices = await fetch(`${baseUrl}/api/devices`);
      expect(await devices.json()).toMatchObject({
        devices: [
          expect.objectContaining({
            id: "555-66-77777:AGENT-RESTART-01",
          }),
        ],
      });
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("marks stale agents offline and restores online status after heartbeat", async () => {
    await closeServer();
    let currentTime = new Date("2026-06-11T02:00:00.000Z");
    server = createApiServer({
      now: () => currentTime,
      offlineAfterMs: 1000,
    });
    await listen();

    const registered = await postJson("/api/agent/first-run", {
      businessNumber: "7778899999",
      password: "1234",
      installId: "agent-heartbeat-01",
    });
    expect(registered.status).toBe(200);
    const registeredBody = await registered.json();

    currentTime = new Date("2026-06-11T02:00:02.000Z");
    const staleDevices = await fetch(`${baseUrl}/api/devices`);
    expect(await staleDevices.json()).toMatchObject({
      devices: [
        expect.objectContaining({
          id: "777-88-99999:AGENT-HEARTBEAT-01",
          status: "offline",
        }),
      ],
    });

    const heartbeat = await postJson("/api/agent/heartbeat", {
      deviceId: registeredBody.device.id,
      installId: "agent-heartbeat-01",
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({
      device: {
        id: "777-88-99999:AGENT-HEARTBEAT-01",
        lastSeenAt: "2026-06-11T02:00:02.000Z",
        status: "online",
      },
    });

    const restoredDevices = await fetch(`${baseUrl}/api/devices`);
    expect(await restoredDevices.json()).toMatchObject({
      devices: [
        expect.objectContaining({
          id: "777-88-99999:AGENT-HEARTBEAT-01",
          status: "online",
        }),
      ],
    });
  });

  it("opens sessions only for agents currently reported online", async () => {
    await closeServer();
    let currentTime = new Date("2026-06-11T03:00:00.000Z");
    server = createApiServer({
      now: () => currentTime,
      offlineAfterMs: 1000,
    });
    await listen();

    const registered = await postJson("/api/agent/first-run", {
      businessNumber: "8889900000",
      password: "1234",
      installId: "agent-online-connect",
    });
    expect(registered.status).toBe(200);
    const registeredBody = await registered.json();

    currentTime = new Date("2026-06-11T03:00:02.000Z");
    const offlineSession = await postJson("/api/sessions", {
      deviceId: registeredBody.device.id,
    });
    expect(offlineSession.status).toBe(409);

    const heartbeat = await postJson("/api/agent/heartbeat", {
      deviceId: registeredBody.device.id,
      installId: "agent-online-connect",
    });
    expect(heartbeat.status).toBe(200);

    const onlineSession = await postJson("/api/sessions", {
      deviceId: registeredBody.device.id,
    });
    expect(onlineSession.status).toBe(200);
    expect(await onlineSession.json()).toMatchObject({
      session: {
        deviceId: "888-99-00000:AGENT-ONLINE-CONNECT",
        state: "connected",
      },
    });
  });

  it("allows posting and getting tiles for a session and clears tiles queue after getting", async () => {
    const connected = await postJson("/api/agent/connect", {
      businessNumber: "1234567890",
      password: "1234",
      storeName: "강남 1호점",
      deviceNumber: "POS-02",
      deviceName: "카운터2",
    });
    const connectedBody = await connected.json();
    const sessionId = connectedBody.session.id;

    const postTiles = await postJson(`/api/sessions/${sessionId}/tiles`, {
      tiles: [{ x: 0, y: 0, w: 32, h: 32, data: "base64tiledata" }],
      width: 1920,
      height: 1080,
    });
    expect(postTiles.status).toBe(200);

    const getTiles1 = await fetch(`${baseUrl}/api/sessions/${sessionId}/tiles`);
    expect(getTiles1.status).toBe(200);
    const body1 = await getTiles1.json();
    expect(body1.tiles).toHaveLength(1);
    expect(body1.tiles[0].data).toBe("base64tiledata");

    const getTiles2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/tiles`);
    expect(getTiles2.status).toBe(200);
    const body2 = await getTiles2.json();
    expect(body2.tiles).toHaveLength(0);
  });

  it("verifies absolute mouse coordinates mapping fidelity for multi-monitor setup", () => {
    const getAbsoluteCoordinate = (clientVal: number, totalClientLen: number) => {
      return Math.floor((clientVal / totalClientLen) * 65535);
    };

    expect(getAbsoluteCoordinate(500, 1000)).toBe(32767);
    expect(getAbsoluteCoordinate(1000, 1000)).toBe(65535);
    expect(getAbsoluteCoordinate(0, 1000)).toBe(0);

    const getAbsoluteCoordinateMultiMonitor = (
      clientVal: number,
      totalClientLen: number,
      monitorOffset: number,
      totalVirtualScreenLen: number,
    ) => {
      const pixelPos = (clientVal / totalClientLen) * totalClientLen;
      const virtualPixelPos = monitorOffset + pixelPos;
      return Math.floor((virtualPixelPos / totalVirtualScreenLen) * 65535);
    };

    const absoluteX = getAbsoluteCoordinateMultiMonitor(960, 1920, 1920, 3840);
    expect(absoluteX).toBe(49151);
  });

  it("supports Phase 3 chatting, clipboard syncing, file uploading, and connection history logging", async () => {
    // 1. Setup session
    const connected = await postJson("/api/agent/connect", {
      businessNumber: "9998877777",
      password: "1234",
      storeName: "역삼 1호점",
      deviceNumber: "POS-02",
      deviceName: "카운터",
    });
    const connectedBody = await connected.json();
    const sessionId = connectedBody.session.id;

    // 2. Chatting test
    const chatPost = await postJson(`/api/sessions/${sessionId}/chat`, {
      message: "안녕하세요 에이전트!",
      sender: "viewer",
    });
    expect(chatPost.status).toBe(200);

    const chatGet = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat`);
    expect(chatGet.status).toBe(200);
    const chatGetBody = await chatGet.json();
    expect(chatGetBody.messages).toHaveLength(1);
    expect(chatGetBody.messages[0]).toMatchObject({
      message: "안녕하세요 에이전트!",
      sender: "viewer",
    });

    const chatGetEmpty = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat`);
    const chatGetEmptyBody = await chatGetEmpty.json();
    expect(chatGetEmptyBody.messages).toHaveLength(0); // queue cleared

    // 3. Clipboard test
    const clipPost = await postJson(`/api/sessions/${sessionId}/clipboard`, {
      text: "복사된 텍스트 내용",
      sender: "viewer",
    });
    expect(clipPost.status).toBe(200);

    const clipGet = await fetch(`${baseUrl}/api/sessions/${sessionId}/clipboard`);
    expect(clipGet.status).toBe(200);
    const clipGetBody = await clipGet.json();
    expect(clipGetBody.clipboards).toHaveLength(1);
    expect(clipGetBody.clipboards[0]).toMatchObject({
      text: "복사된 텍스트 내용",
      sender: "viewer",
    });

    const clipGetEmpty = await fetch(`${baseUrl}/api/sessions/${sessionId}/clipboard`);
    const clipGetEmptyBody = await clipGetEmpty.json();
    expect(clipGetEmptyBody.clipboards).toHaveLength(0); // queue cleared

    // 4. File transfer test
    const filePost = await postJson(`/api/sessions/${sessionId}/files`, {
      filename: "test.txt",
      fileData: Buffer.from("Hello file!").toString("base64"),
    });
    expect(filePost.status).toBe(200);

    const fileGet = await fetch(`${baseUrl}/api/sessions/${sessionId}/files`);
    expect(fileGet.status).toBe(200);
    const fileGetBody = await fileGet.json();
    expect(fileGetBody.files).toHaveLength(1);
    expect(fileGetBody.files[0]).toMatchObject({
      filename: "test.txt",
    });

    // 5. Connection History test
    const historyGet = await fetch(`${baseUrl}/api/connection-history`);
    expect(historyGet.status).toBe(200);
    const historyBody = await historyGet.json();
    expect(historyBody.history.length).toBeGreaterThan(0);
    expect(historyBody.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "999-88-77777:POS-02",
          status: "success",
        }),
      ]),
    );

    // 6. Close session and check closed history entry
    const closeRes = await postJson(`/api/sessions/${sessionId}/close`, {});
    expect(closeRes.status).toBe(200);

    const historyAfterClose = await fetch(`${baseUrl}/api/connection-history`);
    const historyAfterCloseBody = await historyAfterClose.json();
    expect(historyAfterCloseBody.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "999-88-77777:POS-02",
          status: "closed",
        }),
      ]),
    );
  });

  it("serves live update check metadata and packaged update artifacts", async () => {
    // Check update API
    const checkRes = await fetch(`${baseUrl}/api/update/check`);
    expect(checkRes.status).toBe(200);
    const checkBody = await checkRes.json();
    expect(checkBody).toMatchObject({
      latestVersion: expect.any(String),
      forceUpdate: false,
      checksum: expect.any(String),
      downloadUrl: expect.stringContaining("/api/update/download"),
    });

    // Download update API
    const downloadRes = await fetch(`${baseUrl}/api/update/download`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/octet-stream");
    const buffer = await downloadRes.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("serves production installer update metadata from a release manifest file", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "wonremote-manifest-"));
    const manifestPath = path.join(tempDir, "wonremote-update-manifest.json");
    const previousManifestFile = process.env.WONREMOTE_UPDATE_MANIFEST_FILE;
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: "0.1.9",
        windows: {
          x64: {
            name: "WonRemote Viewer_0.1.9_x64-setup.exe",
            url: "https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.9/WonRemote%20Viewer_0.1.9_x64-setup.exe",
            sha256: "b".repeat(64),
            signature: "signature-placeholder",
          },
        },
      }),
      "utf8",
    );

    try {
      process.env.WONREMOTE_UPDATE_MANIFEST_FILE = manifestPath;

      const checkRes = await fetch(`${baseUrl}/api/update/check`);
      expect(checkRes.status).toBe(200);
      expect(await checkRes.json()).toMatchObject({
        assetName: "WonRemote Viewer_0.1.9_x64-setup.exe",
        checksum: "b".repeat(64),
        downloadUrl: expect.stringContaining("github.com/hoguengine-stack/Wonremote/releases/download/v0.1.9"),
        forceUpdate: false,
        latestVersion: "0.1.9",
        reloadViewer: false,
        signature: "signature-placeholder",
        updateKind: "installer",
      });
    } finally {
      if (previousManifestFile === undefined) {
        delete process.env.WONREMOTE_UPDATE_MANIFEST_FILE;
      } else {
        process.env.WONREMOTE_UPDATE_MANIFEST_FILE = previousManifestFile;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serves update packages without depending on artifacts in the app root", async () => {
    const rootGoodZip = path.join(process.cwd(), "wonremote-update-good.zip");
    const rootBadZip = path.join(process.cwd(), "wonremote-update-bad.zip");
    await rm(rootGoodZip, { force: true });
    await rm(rootBadZip, { force: true });

    const downloadRes = await fetch(`${baseUrl}/api/update/download`);

    expect(downloadRes.status).toBe(200);
    expect(await fileExists(rootGoodZip)).toBe(false);
    expect(await fileExists(rootBadZip)).toBe(false);
  });

  it("keeps package.json and runtime app version aligned inside update packages", async () => {
    const downloadRes = await fetch(`${baseUrl}/api/update/download`);
    expect(downloadRes.status).toBe(200);

    const tempDir = await mkdtemp(path.join(tmpdir(), "wonremote-update-pkg-"));
    const zipPath = path.join(tempDir, "update.zip");
    const extractDir = path.join(tempDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    await writeFile(zipPath, Buffer.from(await downloadRes.arrayBuffer()));

    try {
      execFileSync("tar", ["-xf", zipPath, "-C", extractDir]);
      const packageJson = JSON.parse(await readFile(path.join(extractDir, "package.json"), "utf8")) as {
        version: string;
      };
      const appVersionSource = await readFile(path.join(extractDir, "src", "domain", "appVersion.ts"), "utf8");
      const currentPackageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
        version: string;
      };

      expect(packageJson.version).toBe(nextPatchVersion(currentPackageJson.version));
      expect(appVersionSource).toContain(`WONREMOTE_APP_VERSION = "${packageJson.version}"`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function postJson(path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function closeServer() {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async function listen() {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
});
