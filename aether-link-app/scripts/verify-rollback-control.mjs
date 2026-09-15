import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const result = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { ViewerRollbackControl } from './src/components/ViewerRollbackControl';
window.requests=[]; createRoot(document.getElementById('root')).render(<ViewerRollbackControl currentVersion="0.2.0" restore={async version=>{if(window.failRestore) throw new Error('복구 요청 실패'); window.requests.push(version); await new Promise(resolve=>window.finishRestore=resolve);}}/>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife" });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: readFileSync("src/styles.css", "utf8") });
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByRole("button", { name: "뷰어 이전 버전 복구" }).click();
  const submit = page.getByRole("button", { name: "복구 실행" });
  assert.equal(await submit.isDisabled(), true);
  await page.getByLabel("복구할 버전", { exact: true }).fill("0.2.0");
  await page.getByRole("checkbox").check();
  assert.equal(await submit.isDisabled(), true);
  await page.getByLabel("복구할 버전", { exact: true }).fill("0.1.90");
  assert.equal(await page.getByRole("checkbox").isChecked(), false);
  await page.getByRole("checkbox").check();
  mkdirSync(".local-run", { recursive: true });
  await page.evaluate(() => { window.failRestore = true; });
  await submit.click();
  await page.getByText("복구 요청 실패", { exact: true }).waitFor();
  assert.equal(await submit.isDisabled(), false);
  await page.evaluate(() => { window.failRestore = false; });
  await page.screenshot({ path: ".local-run/rollback-confirmation.png" });
  await submit.click();
  assert.deepEqual(await page.evaluate(() => window.requests), ["0.1.90"]);
  assert.equal(await submit.isDisabled(), true);
  await page.evaluate(() => window.finishRestore());
  await page.getByText("복구 요청됨 · 검증 후 뷰어가 재시작됩니다.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "뷰어 이전 버전 복구" }).click();
  assert.equal(await submit.isDisabled(), true);
  console.log("rollback confirmation: valid older version, explicit consent and single submission passed");
} finally { await browser.close(); }
