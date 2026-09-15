import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const result = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { DesktopRemoteKeyboardRecovery } from './src/components/DesktopRemoteKeyboardRecovery';

      window.remoteKeys = [];
      const isLocalControlTarget = target => target instanceof Element && Boolean(target.closest(
        "button, input, select, summary, textarea:not([data-remote-ime-input='true']), a[href], [contenteditable='true'], [role='button']"
      ));

      function App() {
        const panelRef = React.useRef(null);
        const imeInputRef = React.useRef(null);
        const [enabled, setEnabled] = React.useState(true);
        const onKeyDown = event => {
          event.preventDefault();
          window.remoteKeys.push('down:' + event.key);
        };
        const onKeyUp = event => {
          event.preventDefault();
          window.remoteKeys.push('up:' + event.key);
        };
        window.setRecoveryEnabled = setEnabled;
        window.recoveryEnabled = enabled;
        return <>
          <section ref={panelRef} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
            <textarea ref={imeInputRef} data-remote-ime-input="true" aria-label="원격 입력" />
            <button type="button">세션 도구</button>
          </section>
          <div id="outside" tabIndex="0">outside focus</div>
          <input id="local-input" aria-label="로컬 입력" />
          <DesktopRemoteKeyboardRecovery enabled={enabled} panelRef={panelRef} imeInputRef={imeInputRef}
            isLocalControlTarget={isLocalControlTarget} onKeyDown={onKeyDown} onKeyUp={onKeyUp} />
        </>;
      }

      createRoot(document.getElementById('root')).render(<App />);
    `,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  jsx: "automatic",
  write: false,
});

const server = createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(result.outputFiles[0].text);
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end('<div id="root"></div><script type="module" src="/app.js"></script>');
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  await page.getByLabel("원격 입력").focus();
  await page.keyboard.press("F2");
  assert.deepEqual(await page.evaluate(() => window.remoteKeys), ["down:F2", "up:F2"]);

  await page.evaluate(() => { window.remoteKeys = []; });
  await page.locator("#outside").focus();
  await page.keyboard.press("F3");
  assert.deepEqual(await page.evaluate(() => window.remoteKeys), ["down:F3", "up:F3"]);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "원격 입력");

  await page.evaluate(() => { window.remoteKeys = []; });
  await page.getByLabel("로컬 입력").fill("local");
  await page.keyboard.press("F4");
  assert.deepEqual(await page.evaluate(() => window.remoteKeys), []);
  assert.equal(await page.getByLabel("로컬 입력").inputValue(), "local");

  await page.evaluate(() => { window.remoteKeys = []; window.setRecoveryEnabled(false); });
  await page.waitForFunction(() => window.recoveryEnabled === false);
  await page.locator("#outside").focus();
  await page.keyboard.press("F5");
  assert.deepEqual(await page.evaluate(() => window.remoteKeys), []);
  assert.deepEqual(errors, []);
  console.log("PASS: desktop keyboard focus recovery, local-control exclusion, disabled mobile-equivalent path, and no duplicate panel events.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
