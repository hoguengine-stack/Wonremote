import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const result = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MobileRemoteControls, useMobileRemoteHeight } from './src/components/MobileRemoteControls';
    import { buildMouseCommand } from './src/domain/remoteControlCommands';
    window.commands = []; window.clicks = []; window.scrolls = []; window.keyboardOpens = 0;
    function App() {
      const [zoom, setZoom] = React.useState(1);
      const height = useMobileRemoteHeight(true);
      return <section className="mobile-remote-controls-test" style={{height}}>
        <canvas style={{transform: 'scale('+zoom+')', width: 100, height: 60}}/>
        <textarea aria-label="IME" data-remote-ime-input="true"/>
        <MobileRemoteControls send={c => window.commands.push(c)} click={b => {window.clicks.push(b); window.commands.push(buildMouseCommand('down',12345,23456,b),buildMouseCommand('up',12345,23456,b));}}
          scroll={d => {window.scrolls.push(d); window.commands.push(buildMouseCommand('wheel',12345,23456,0,d));}} keyboard={() => {window.keyboardOpens++; document.querySelector('textarea').focus();}}
          zoom={d => setZoom(z => z+d)} settings={() => {}}/>
      </section>;
    }
    window.root = createRoot(document.getElementById('root')); window.root.render(<App/>);
  `, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, jsx: "automatic", format: "esm",
});
const css = readFileSync("src/styles.css", "utf8");
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(result.outputFiles[0].text); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/app.js"></script>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({hasTouch: true});
  await page.addInitScript(() => {
    window.pinReads = 0; window.pinWrites = 0;
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === 'wonremote-pinned-keys') window.pinReads++; return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === 'wonremote-pinned-keys') { window.pinWrites++; if (window.blockPins) throw new Error('blocked'); } return set.call(this, key, value); };
    Object.defineProperty(screen.orientation, 'type', {get: () => innerWidth < innerHeight ? 'portrait-primary' : 'landscape-primary'});
    const viewport = new EventTarget(); viewport.height = innerHeight;
    Object.defineProperty(window, 'visualViewport', {value: viewport});
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [width, height] of [[360, 800], [800, 360], [320, 640]]) {
    await page.setViewportSize({width, height});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", {name: "좌클릭", exact: true}).click();
    for (const visibleHeight of [height - 220, height - 330, height]) {
      await page.evaluate(h => { window.visualViewport.height = h; window.visualViewport.dispatchEvent(new Event('resize')); }, visibleHeight);
      await page.waitForFunction(({portrait, h}) => document.querySelector('section').style.height === (portrait ? h+'px' : ''), {portrait: width < height, h: visibleHeight});
    }
    await page.getByRole("button", {name: "우클릭", exact: true}).click();
    await page.getByRole("button", {name: "위로 스크롤", exact: true}).click();
    await page.getByRole("button", {name: "아래로 스크롤", exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.clicks), [0, 2]);
    assert.deepEqual(await page.evaluate(() => window.scrolls), [120, -120]);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "BODY");
    await page.evaluate(() => { window.commands=[]; window.clicks=[]; window.scrolls=[]; });
    for (const name of ['좌클릭', '우클릭', '위로 스크롤', '아래로 스크롤']) {
      await page.getByRole('button', {name, exact:true}).tap();
    }
    assert.deepEqual(await page.evaluate(() => window.commands), [
      'mouse-down 12345 23456 left', 'mouse-up 12345 23456 left',
      'mouse-down 12345 23456 right', 'mouse-up 12345 23456 right',
      'mouse-wheel 12345 23456 120', 'mouse-wheel 12345 23456 -120',
    ]);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
    await page.evaluate(() => { window.commands=[]; });
    const button = page.getByRole("button", {name: "확대", exact: true});
    const before = await button.boundingBox();
    await button.click();
    const after = await button.boundingBox();
    assert.equal(before.height, after.height);
    assert.equal(before.width, after.width);
    assert.ok(after.width >= 44 && after.height >= 44);
    assert.equal(await page.locator('.mobile-touch-bar').evaluate(bar => bar.scrollWidth <= bar.clientWidth), true);
    assert.notEqual(await page.locator("canvas").evaluate(e => getComputedStyle(e).transform), "matrix(1, 0, 0, 1, 0, 0)");
    await page.getByRole("button", {name: "키보드", exact: true}).tap();
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
    assert.equal(await page.evaluate(() => window.keyboardOpens), 1);
    await page.getByRole("button", {name: "Windows 특수키"}).tap();
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
    await page.getByRole("button", {name: "Ctrl", exact: true}).tap();
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
    await page.getByRole("button", {name: "Ctrl", exact: true}).tap();
    for (const name of ["Alt", "Shift"]) {
      await page.getByRole("button", {name: "키보드", exact: true}).tap();
      assert.equal(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
      await page.getByRole("button", {name, exact: true}).tap();
      assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
      await page.getByRole("button", {name, exact: true}).tap();
    }
    assert.equal(await page.evaluate(() => window.keyboardOpens), 3);
    await page.evaluate(() => { window.commands=[]; });
    await page.getByRole("button", {name: "Ctrl", exact: true}).tap();
    await page.getByRole("tab", {name: "F1–F12"}).click();
    await page.getByRole("button", {name: "F12", exact: true}).click();
    await page.getByRole("button", {name: "Windows 특수키"}).click();
    assert.deepEqual(await page.evaluate(() => window.commands), ["key-down Ctrl", "key-down F12", "key-up F12", "key-up Ctrl"]);
    await page.getByRole("button", {name: "Windows 특수키"}).click();
    await page.getByRole("tab", {name: "단축키"}).click();
    await page.locator('.mobile-key-grid').getByRole("button", {name: "Win+D", exact: true}).click();
    assert.deepEqual((await page.evaluate(() => window.commands)).slice(-4), ["key-down Win", "key-down D", "key-up D", "key-up Win"]);
    assert.equal(await page.locator('.mobile-key-grid button').evaluateAll(buttons => buttons.every(b => b.scrollWidth <= b.clientWidth)), true);
    assert.deepEqual(await page.evaluate(() => [window.pinReads, window.pinWrites]), [1, 0]);
    await page.getByRole('button', {name: '고정 단축키 편집'}).tap();
    const pinnedBefore = await page.getByRole('toolbar', {name: '고정 단축키'}).getByRole('button').allTextContents();
    const commandCount = await page.evaluate(() => window.commands.length);
    await page.locator('.mobile-key-grid').getByRole('button', {name: 'Win+E', exact:true}).tap();
    assert.equal(await page.evaluate(() => window.commands.length), commandCount);
    assert.deepEqual(await page.evaluate(() => [window.pinReads, window.pinWrites]), [1, 1]);
    await page.getByRole('button', {name:'Windows 특수키'}).tap();
    // Toggle twice so every viewport leaves the same persisted favorite set.
    await page.getByRole('button', {name:'Windows 특수키'}).tap();
    await page.locator('.mobile-key-grid').getByRole('button', {name:'Win+E', exact:true}).tap();
    assert.deepEqual(await page.getByRole('toolbar', {name:'고정 단축키'}).getByRole('button').allTextContents(), pinnedBefore);
    await page.getByRole('button', {name:'Windows 특수키'}).tap();
    await page.getByRole('toolbar', {name:'고정 단축키'}).getByRole('button', {name:'Win+D', exact:true}).tap();
    assert.deepEqual((await page.evaluate(() => window.commands)).slice(-4), ['key-down Win','key-down D','key-up D','key-up Win']);
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA');
    assert.equal(await page.evaluate(() => window.keyboardOpens), 3);
    await page.getByRole('button', {name:'Windows 특수키'}).tap();
    await page.screenshot({path: `../.codex-tmp/mobile-controls-${width}x${height}.png`});
    await page.getByRole("button", {name: "Alt", exact: true}).click();
    await page.evaluate(() => window.root.unmount());
    assert.equal((await page.evaluate(() => window.commands)).at(-1), "key-up Alt");
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', {name:'Windows 특수키'}).tap();
  await page.getByRole('tab', {name:'단축키'}).tap();
  await page.getByRole('button', {name:'고정 단축키 편집'}).tap();
  await page.locator('.mobile-key-grid').getByRole('button', {name:'Win+E', exact:true}).tap();
  await page.reload();
  await page.getByRole('toolbar', {name:'고정 단축키'}).getByRole('button', {name:'Win+E', exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.pinReads,window.pinWrites]), [1,0]);
  await page.getByRole('button', {name:'Windows 특수키'}).tap();
  await page.getByRole('tab', {name:'단축키'}).tap();
  await page.getByRole('button', {name:'고정 단축키 편집'}).tap();
  await page.evaluate(() => { window.blockPins = true; });
  await page.locator('.mobile-key-grid').getByRole('button', {name:'Win+E', exact:true}).tap();
  assert.match(await page.getByRole('status').innerText(), /저장하지 못했습니다/);
  assert.equal(await page.evaluate(() => window.pinWrites), 1);
  await page.clock.install();
  await page.clock.fastForward(24 * 60 * 60 * 1000);
  assert.deepEqual(await page.evaluate(() => [window.pinReads,window.pinWrites]), [1,1]);
  await page.evaluate(() => { window.blockPins=false; localStorage.setItem('wonremote-pinned-keys', JSON.stringify(['Win+D','Win+D','invalid-command','Esc'])); });
  await page.reload();
  await page.getByRole('toolbar', {name:'고정 단축키'}).waitFor();
  assert.deepEqual(await page.getByRole('toolbar', {name:'고정 단축키'}).getByRole('button').allTextContents(), ['Win+D','Esc']);
  await page.getByRole('button', {name:'Windows 특수키'}).tap();
  await page.getByRole('tab', {name:'단축키'}).tap();
  await page.getByRole('button', {name:'고정 단축키 편집'}).tap();
  for (const name of ['Ctrl+C','Ctrl+V','Ctrl+X','Ctrl+A']) await page.locator('.mobile-key-grid').getByRole('button', {name,exact:true}).tap();
  assert.equal(await page.locator('.mobile-key-grid').getByRole('button', {name:'Win+E',exact:true}).isDisabled(), true);
  assert.equal(await page.getByRole('toolbar', {name:'고정 단축키'}).getByRole('button').count(), 6);
  assert.deepEqual(errors, []);
  console.log("PASS: 3 viewports; clicks, scroll, explicit focus, fixed toolbar zoom, key groups/chords and unmount release.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
