import { readFileSync } from "node:fs";
import { build } from "esbuild";
import ts from "typescript";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { App } from "./src/App"; window.root = createRoot(document.getElementById("root")); window.root.render(<React.StrictMode><App /></React.StrictMode>);',
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, outfile: "viewer-test.js", platform: "browser", format: "iife",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "offline-firebase-boundary", setup(builder) {
      builder.onLoad({ filter: /[\\/]firebase[\\/]viewerFirebase\.ts$/ }, ({ path }) => {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
        const names = source.statements.filter(ts.isFunctionDeclaration)
          .filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
          .map((node) => node.name!.text);
        return { contents: names.map((name) => `export const ${name} = (...args) => window.testApi.${name}(...args);`).join("\n") };
      });
    } }],
  });
  bundle = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); });

async function openViewer(options: { slow?: boolean; fail?: boolean; local?: boolean; connected?: boolean; autoRefresh?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(3_000);
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "http://viewer.test/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (options.local && url.endsWith("/api/admin/login") && route.request().method() === "POST") return route.fulfill({ json: {}, headers: { "access-control-allow-origin": "*" } });
    if (options.local && new URL(url).pathname === "/api/devices") {
      const devices = await page.evaluate(() => (window as any).testApi.fetchFirebaseDevices());
      return route.fulfill({ json: { devices }, headers: { "access-control-allow-origin": "*" } });
    }
    if (options.local && route.request().method() === "OPTIONS") {
      return route.fulfill({ headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    }
    return route.abort();
  });
  await page.goto("http://viewer.test/");
  await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
  await page.clock.install();
  await page.evaluate((opts) => {
    const w = window as any;
    const state = w.testState = {
      reads: 0, subscriptions: 0, connections: [] as string[], slow: Boolean(opts.slow), fail: Boolean(opts.fail),
      auxiliaryReads: 0, auxiliarySubscriptions: [] as any[], auxiliaryStops: 0,
      historyReads: 0, historySubscriptions: 0, rtcStarts: 0,
      devices: Array.from({ length: 10 }, (_, i) => ({
        id: `device-${i}`, deviceNumber: `AGENT-${i}`, businessNumber: "123-45-67890",
        desktopName: `PC-${i}`, deviceName: "POS", storeName: "Store", status: i === 9 ? "online" : "offline", protocolVersion: 1,
        lastSeenAt: new Date().toISOString(),
      })),
    };
    w.testApi = new Proxy({
      isViewerFirebaseEnabled: () => !opts.local,
      subscribeViewerAuthState: (next: (authenticated: boolean) => void) => {
        w.authChanged = next; next(true); return () => {};
      },
      subscribeFirebaseDevices: (next: (devices: unknown[]) => void) => {
        state.subscriptions++; next(structuredClone(state.devices)); return () => {};
      },
      subscribeFirebaseConnectionHistory: (next: (history: unknown[]) => void) => { state.historySubscriptions++; next([]); return () => {}; },
      fetchFirebaseConnectionHistory: async () => { state.historyReads++; return []; },
      isCurrentViewerAccountManager: async () => false,
      fetchFirebaseDevices: async () => {
        state.reads++;
        const devices = structuredClone(state.devices);
        if (state.slow) await new Promise<void>((resolve) => { w.finishRead = resolve; });
        if (state.fail) throw new Error("Quota exceeded.");
        return devices;
      },
      openFirebaseSession: async (id: string) => {
        state.connections.push(id);
        if (opts.connected) return { session: { id: "remote-session", deviceId: id, state: "connected", startedAt: new Date().toISOString() }, inputLog: [] };
        throw new Error("Current target is offline.");
      },
      startFirebaseViewerWebRtcTransport: async (_id: string, callbacks: any) => {
        state.rtcStarts++; w.rtcCallbacks = callbacks;
        callbacks.onState("webrtc-open");
        return { close: () => {}, isControlReady: () => true, sendControl: () => true };
      },
      subscribeViewerSessionData: (_id: string, next: (data: any) => void, _error: unknown, options: unknown) => {
        state.auxiliarySubscriptions.push({ next, options }); return () => { state.auxiliaryStops++; };
      },
      fetchFirebaseChatMessages: async () => { state.auxiliaryReads++; return []; },
      fetchFirebaseClipboardText: async () => { state.auxiliaryReads++; return []; },
      fetchFirebaseFiles: async () => { state.auxiliaryReads++; return []; },
      fetchFirebaseFileTransferReceipts: async () => { state.auxiliaryReads++; return []; },
      requestFirebaseSecureSession: async (id: string) => { state.connections.push(`secure:${id}`); throw new Error("Current target is offline."); },
      logoutViewerWithFirebase: async () => { w.authChanged(false); },
    }, { get(target, key) { return (target as any)[key] ?? (async () => null); } });
  }, options);
  await page.addScriptTag({ content: bundle });
  if (options.local) {
    await page.locator('input[name="username"]').fill("test");
    await page.locator('input[name="password"]').fill("test");
    await page.locator('button[type="submit"]').first().click();
  }
  if (options.autoRefresh !== false) await page.getByRole("button", { name: "장비 목록 새로고침", exact: true }).click();
  return page;
}

const counts = (page: Page) => page.evaluate(() => {
  const state = (window as any).testState;
  return { reads: state.reads, subscriptions: state.subscriptions };
});
const refresh = (page: Page) => page.getByRole("button", { name: "장비 목록 새로고침", exact: true });

describe("manual Viewer device list in a real browser", () => {
  it("requires an explicit refresh before first list/history reads, with no idle subscriptions", async () => {
    const page = await openViewer({ autoRefresh: false });
    try {
      await refresh(page).waitFor();
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 0, subscriptions: 0 });
      expect(await page.evaluate(() => [(window as any).testState.historyReads, (window as any).testState.historySubscriptions])).toEqual([0, 0]);
      await page.getByRole("button", { name: "연결 이력 새로고침", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.historyReads === 1);
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 0, subscriptions: 0 });
      expect(await page.evaluate(() => (window as any).testState.historyReads)).toBe(1);
      await refresh(page).click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("reconnects only from the session refresh button after a transport failure", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts === 1);
      await page.evaluate(() => (window as any).rtcCallbacks.onError(new Error("Disconnected")));
      await page.clock.fastForward(86_400_000);
      expect(await page.evaluate(() => (window as any).testState.rtcStarts)).toBe(1);
      await page.getByRole("button", { name: "원격 연결 새로고침", exact: true }).click();
      await page.waitForFunction(() => (window as any).testState.rtcStarts === 2);
    } finally { await page.close(); }
  });
  it("does not poll unused session features, keeps one subscription through rerenders and closes it on exit", async () => {
    const page = await openViewer({ connected: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) }).getByRole("button", { name: "접속", exact: true }).click();
      await page.getByRole("button", { name: "세션 종료", exact: true }).waitFor();
      await page.clock.fastForward(86_400_000);
      const stats = await page.evaluate(() => {
        const s = (window as any).testState;
        return { reads: s.auxiliaryReads, count: s.auxiliarySubscriptions.length, options: s.auxiliarySubscriptions[0]?.options };
      });
      expect(stats.reads).toBe(0); expect(stats.count).toBe(1);
      expect(stats.options.clipboard).toBe(false); expect(stats.options.receiptIds ?? []).toHaveLength(0);
      await page.getByRole("button", { name: "세션 종료", exact: true }).click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await page.evaluate(() => (window as any).testState.auxiliaryStops)).toBe(1);
    } finally { await page.close(); }
  });
  it("loads once, remains idle for 24h and rerenders, then reads once per explicit refresh", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await page.clock.fastForward(86_400_000);
      expect(await page.locator(".table-row").filter({ has: page.getByText("PC-9", { exact: true }) }).locator(".status-pill").innerText()).toBe("온라인");
      await page.getByPlaceholder("매장, 장비, 담당자, 위치, 태그 검색").fill("PC-0");
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      for (let i = 0; i < 10; i++) {
        await refresh(page).click();
        await page.waitForFunction((reads) => (window as any).testState.reads === reads, i + 2);
      }
      expect(await counts(page)).toEqual({ reads: 11, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("coalesces slow refresh clicks and ignores completion after logout, then reloads on login", async () => {
    const page = await openViewer({ slow: true });
    try {
      await page.waitForFunction(() => (window as any).testState.reads === 1);
      for (let i = 0; i < 5; i++) await refresh(page).dispatchEvent("click");
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await page.evaluate(() => (window as any).authChanged(false));
      await page.locator('input[name="username"]').waitFor();
      await page.evaluate(() => {
        const w = window as any; w.testState.slow = false;
        w.testState.devices[0].desktopName = "New-PC"; w.authChanged(true);
      });
      await refresh(page).click();
      await page.getByText("New-PC", { exact: true }).waitFor();
      await page.evaluate(() => (window as any).finishRead());
      await page.clock.fastForward(86_400_000);
      expect(await page.getByText("PC-0", { exact: true }).count()).toBe(0);
      expect(await page.getByText("New-PC", { exact: true }).count()).toBe(1);
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("does not retry quota errors until manual refresh", async () => {
    const page = await openViewer({ fail: true });
    try {
      await page.getByText("Quota exceeded.", { exact: true }).waitFor();
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await page.evaluate(() => { (window as any).testState.fail = false; });
      await refresh(page).click();
      await page.getByText("PC-0", { exact: true }).waitFor();
      expect(await counts(page)).toEqual({ reads: 2, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("lets stale offline rows reach normal, secure and split connection checks", async () => {
    const page = await openViewer();
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      const row = page.locator(".table-row").filter({ has: page.getByText("PC-0", { exact: true }) });
      expect(await row.getByRole("button", { name: "접속", exact: true }).isEnabled()).toBe(true);
      await row.getByRole("button", { name: "접속", exact: true }).click();
      await page.getByText("Current target is offline.", { exact: true }).waitFor();
      await row.getByRole("button", { name: "보안접속", exact: true }).click();
      await page.getByRole("checkbox", { name: "PC-0 선택", exact: true }).check();
      await page.getByRole("checkbox", { name: "PC-1 선택", exact: true }).check();
      await page.getByRole("button", { name: /좌우 분할/ }).click();
      expect(await page.evaluate(() => (window as any).testState.connections)).toEqual(["device-0", "secure:device-0", "device-0", "device-1"]);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
    } finally { await page.close(); }
  });

  it("also avoids list polling and duplicate login reads in local mode", async () => {
    const page = await openViewer({ local: true });
    try {
      await page.getByText("PC-0", { exact: true }).waitFor();
      await page.clock.fastForward(86_400_000);
      expect(await counts(page)).toEqual({ reads: 1, subscriptions: 0 });
      await refresh(page).click();
      await page.waitForFunction(() => (window as any).testState.reads === 2);
    } finally { await page.close(); }
  });
});
