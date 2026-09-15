import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = (await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AgentFirstRunApp} from './src/App'; createRoot(document.getElementById('root')).render(<AgentFirstRunApp/>);`, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, outfile: "agent-ui-test.js", format: "iife", define: { "import.meta.env": "{}" },
  plugins: [{ name: "agent-ui-boundary", setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]App\.tsx$/ }, ({ path }) => ({ contents: readFileSync(path, "utf8") + "\nexport {AgentFirstRunApp};", loader: "tsx" }));
    builder.onLoad({ filter: /[\\/]firebase[\\/]viewerFirebase\.ts$/ }, ({ path }) => ({ contents: readFileSync(path, "utf8").replace("return resolveFirebaseConfig(env) !== null;", "return window.fixture.firebase;"), loader: "ts" }));
  } }],
})).outputFiles.find(file => file.path.endsWith(".js")).text;
const browser = await chromium.launch({ headless: true });
try {
  for (const firebase of [true, false]) for (const registered of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 340 } });
    await page.route("**/*", route => route.request().url() === "http://agent-ui.test/" ? route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><div id="root"></div>' }) : route.abort());
    await page.goto("http://agent-ui.test/");
    await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(({ firebase, registered }) => {
      window.fixture = { firebase, registered };
      window.__TAURI_INTERNALS__ = { invoke: async command => {
        if (command === "get_agent_config") return registered ? { registeredDeviceId: "AGENT-82220F6D", businessNumber: "123-45-67890", installId: "agent-12345678-1234-1234-1234-123456789abc", apiUrl: "http://127.0.0.1:8787" } : null;
        if (command === "get_or_create_agent_install_id") return "agent-12345678-1234-1234-1234-123456789abc";
        if (command === "get_computer_name") return "TEST-PC";
        throw new Error(`Unexpected native command: ${command}`);
      } };
    }, { firebase, registered });
    await page.addScriptTag({ content: bundle });
    await page.getByRole("heading", { name: registered ? "Agent 가동 중" : "Agent 최초 실행", exact: true }).waitFor();
    if (registered) {
      const metrics = await page.locator(".agent-action-row").evaluate(row => ({ bottom: row.getBoundingClientRect().bottom, width: document.documentElement.scrollWidth }));
      assert.ok(metrics.bottom <= 340, `Actions clipped: ${metrics.bottom}`);
      assert.ok(340 - metrics.bottom <= 80, `Excess bottom space: ${340 - metrics.bottom}`);
      assert.equal(metrics.width, 360);
      for (const node of await page.locator(".active-agent-result strong, .active-agent-result code, .agent-status-copy, .agent-action-row button span").all()) {
        if (!await node.isVisible()) continue;
        assert.equal(await node.evaluate(el => getComputedStyle(el).whiteSpace), "nowrap");
        const lines = await node.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size; });
        assert.equal(lines, 1);
      }
      await page.getByRole("button", { name: "에이전트 재시작", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("button", { name: "취소", exact: true }).click();
    } else {
      await page.getByPlaceholder("사업자번호").fill("123-45-67890");
      await page.getByRole("button", { name: "등록", exact: true }).scrollIntoViewIfNeeded();
      assert.ok(await page.getByRole("button", { name: "등록", exact: true }).isEnabled());
      const bounds = await page.getByRole("button", { name: "등록", exact: true }).boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 340, "Registration action clipped");
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `.local-run/agent-${firebase ? "firebase" : "local"}-${registered ? "active" : "first"}.png` });
    await page.close();
  }
  console.log("Agent UI: four first-run/active and Firebase/local cases passed at360x340; nowrap, compact space and restart dialog verified.");
} finally { await browser.close(); }
